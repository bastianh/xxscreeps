import type { Shard } from 'xxscreeps/engine/db/index.js';
import type { RunnerPlayerEvalPayload, RunnerPlayerIntent, TickUsageResult } from 'xxscreeps/engine/runner/index.js';
import { config } from 'xxscreeps/config/index.js';
import { Channel } from 'xxscreeps/engine/db/channel.js';
import { tickSpeed } from 'xxscreeps/engine/service/tick.js';
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
