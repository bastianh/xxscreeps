import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import type { RunnerPlayerEvalPayload, RunnerPlayerIntent, TickUsageResult } from 'xxscreeps/engine/runner/index.js';
import { config } from 'xxscreeps/config/index.js';
import { Channel } from 'xxscreeps/engine/db/channel.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { tickSpeed } from 'xxscreeps/engine/service/tick.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { acquireTimeout } from 'xxscreeps/utility/utility.js';

export function getConsoleChannel(shard: Shard, user: string) {
	return new Channel<string>(shard.pubsub, `user/${user}/console`, false);
}

export function getAckChannel(shard: Shard, user: string) {
	type Message = {
		id: string;
		result: { error: boolean; value: string | undefined };
	};
	return new Channel<Message>(shard.pubsub, `user/${user}/ack`);
}

export function getRunnerChannel(shard: Shard) {
	type RunnerMessage =
		{ type: 'shutdown' } |
		{ type: 'run'; time: number };
	return new Channel<RunnerMessage>(shard.pubsub, 'channel/runner');
}

// Messages sent to the runner for an individual user
/** @internal */
export type RunnerUserChannel = Channel<
	{ type: 'eval'; payload: RunnerPlayerEvalPayload } |
	{ type: 'intent'; intent: RunnerPlayerIntent }
>;

export const runnerUserChannel =
	(shard: Shard, user: string): RunnerUserChannel => new Channel(shard.pubsub, `runner/${user}`);

export const runnerUsageChannel =
	(shard: Shard, user: string) => new Channel<TickUsageResult>(shard.pubsub, `runner/${user}/usage`);

/**
 * Sends an eval expression to the user's runner instance and waits for a reply.
 */
export async function requestRunnerEval(shard: Shard, userId: string, expr: string, echo: boolean) {
	using disposable = new DisposableStack();
	// Response timeout
	const timer = Promise.withResolvers<never>();
	using _timeout = acquireTimeout(
		Math.max(500, tickSpeed * 4),
		() => timer.reject(new Error('Runner did not respond')),
	);

	// Response promise
	const id = `${Math.random()}`;
	const [ effect, promise ] = getAckChannel(shard, userId).listenFor(message => message.id === id);
	disposable.defer(effect);

	// Send the request
	await runnerUserChannel(shard, userId).publish({ type: 'eval', payload: { ack: id, echo, expr } });
	const { result } = (await Promise.race([ timer.promise, promise ]))!;
	if (result.error) {
		throw new Error(result.value);
	} else {
		return result.value;
	}
}

export const runnerUsersSetKey = (time: number) =>
	`tick${time % 2}/runnerUsers`;

// The bucket lives with the shard's persistent data rather than in the runner's memory, so that
// restarting a runner -- or migrating a player's sandbox to another one -- doesn't hand out a full
// bucket. It belongs to the shard: a user gets one per shard they run on.
const userBucketKey = (userId: string) => `user/${userId}/bucket`;

export async function loadUserBucket(shard: Shard, userId: string) {
	const stored = await shard.data.get(userBucketKey(userId));
	const bucket = stored === null ? NaN : Number(stored);
	return Number.isFinite(bucket) ? bucket : config.runner.cpu.bucket;
}

export function saveUserBucket(shard: Shard, userId: string, bucket: number) {
	return shard.data.set(userBucketKey(userId), String(bucket));
}

export function deleteUserBucket(shard: Shard, userId: string) {
	return shard.data.vDel(userBucketKey(userId));
}

// A user's CPU allowance is an account-level number, and how they split it across shards is too,
// so both live in the global database rather than any one shard's. The split doubles as each
// shard's bucket refill rate: half the CPU means the bucket fills half as fast.
const cpuShardsKey = (userId: string) => `user/${userId}/cpuShards`;
const kCpuChangedField = 'cpuShardsChanged';

export async function loadAccountCpu(db: Database, userId: string) {
	const stored = await db.data.hGet(User.infoKey(userId), 'cpu');
	const cpu = stored === null ? NaN : Number(stored);
	return Number.isFinite(cpu) ? cpu : config.runner.cpu.limit;
}

/**
 * How much CPU a user gets per tick on each configured shard. An unallocated account is split
 * evenly, with the remainder going to the first shard so the parts always add up to the whole.
 */
export async function loadShardLimits(db: Database, userId: string) {
	const [ total, stored ] = await Promise.all([
		loadAccountCpu(db, userId),
		db.data.hGetAll(cpuShardsKey(userId)),
	]);
	const names = config.shards.map(shard => shard.name);
	const allocated = Fn.every(names, name => stored[name] !== undefined);
	if (allocated) {
		return Fn.fromEntries(Fn.map(names, name => [ name, Number(stored[name]) ] as const));
	}
	const share = Math.floor(total / names.length);
	return Fn.fromEntries(Fn.map(names, (name, index) =>
		[ name, index === 0 ? total - share * (names.length - 1) : share ] as const));
}

/**
 * Rejects a split which doesn't add up to the account's CPU, or which arrives before the cooldown
 * is up. Returns `null` on success, or the reason it was refused.
 */
export async function saveShardLimits(db: Database, userId: string, limits: Record<string, number>) {
	const names = config.shards.map(shard => shard.name);
	const values = names.map(name => limits[name]);
	if (values.some(value => value === undefined || !Number.isInteger(value) || value < 0)) {
		return 'invalid';
	}
	const total = await loadAccountCpu(db, userId);
	if (Fn.accumulate(values as number[]) !== total) {
		return 'total mismatch';
	}
	const cooldown = config.runner.cpu.shardLimitsCooldown * 3600000;
	if (cooldown > 0) {
		const changed = Number(await db.data.hGet(User.infoKey(userId), kCpuChangedField));
		if (Number.isFinite(changed) && Date.now() - changed < cooldown) {
			return 'busy';
		}
	}
	const key = cpuShardsKey(userId);
	await Promise.all([
		...Fn.map(names, name => db.data.hSet(key, name, limits[name]!)),
		db.data.hSet(User.infoKey(userId), kCpuChangedField, Date.now()),
	]);
	await cpuShardLimitsChannel(db, userId).publish(null);
	return null;
}

/** When the split was last changed, so the runtime can answer `ERR_BUSY` without a round trip. */
export async function loadShardLimitsChanged(db: Database, userId: string) {
	const stored = await db.data.hGet(User.infoKey(userId), kCpuChangedField);
	const changed = stored === null ? NaN : Number(stored);
	return Number.isFinite(changed) ? changed : 0;
}

export function deleteShardLimits(db: Database, userId: string) {
	return db.data.vDel(cpuShardsKey(userId));
}

/**
 * Announces a changed split. It rides the global pubsub rather than a shard's, because every
 * shard's runner holds a copy and they all have to drop it at once.
 */
export type CpuShardLimitsChannel = Channel<null>;

export const cpuShardLimitsChannel = (db: Database, userId: string): CpuShardLimitsChannel =>
	new Channel(db.pubsub, `user/${userId}/cpuShards`);
