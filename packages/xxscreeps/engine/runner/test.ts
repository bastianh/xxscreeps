import type { TickPayload } from 'xxscreeps/engine/runner/index.js';
import { config } from 'xxscreeps/config/index.js';
import { BaseCPU, flushShardLimitsRequest } from 'xxscreeps/driver/runtime/cpu.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { loadAccountCpu, loadShardLimits, saveShardLimits } from './model.js';

// `BaseCPU` reads the division straight off the tick payload, so it can be exercised over any
// number of shards without a server configured for them.
class TestCPU extends BaseCPU {
	getUsed() {
		return 0;
	}
}

const makeCpu = (shardLimits: Record<string, number>, shardLimitsCooldown = 0) =>
	new TestCPU({
		cpu: { bucket: 10000, limit: 0, shardLimits, shardLimitsCooldown, tickLimit: 500 },
	} satisfies Partial<TickPayload> as TickPayload);

describe('engine/runner cpu', () => {
	test('an unallocated account holds its whole limit', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const limits = await loadShardLimits(db, '100');
		assert.deepStrictEqual(Object.keys(limits), config.shards.map(shard => shard.name));
		assert.strictEqual(
			Object.values(limits).reduce((sum, value) => sum + value, 0),
			await loadAccountCpu(db, '100'));
	});

	test('the account limit is whatever it was set to', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		assert.strictEqual(await loadAccountCpu(db, '100'), config.runner.cpu.limit);
		await db.data.hSet(User.infoKey('100'), 'cpu', 300);
		assert.strictEqual(await loadAccountCpu(db, '100'), 300);
		const limits = await loadShardLimits(db, '100');
		assert.strictEqual(Object.values(limits).reduce((sum, value) => sum + value, 0), 300);
	});

	test('a division which does not add up to the limit is refused', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const [ name ] = config.shards.map(shard => shard.name);
		const total = await loadAccountCpu(db, '100');
		assert.strictEqual(await saveShardLimits(db, '100', { [name!]: total + 1 }), 'total mismatch');
		assert.strictEqual(await saveShardLimits(db, '100', { [name!]: total - 1 }), 'total mismatch');
		// And the stored division is untouched by a refusal
		assert.strictEqual(Object.values(await loadShardLimits(db, '100'))
			.reduce((sum, value) => sum + value, 0), total);
	});

	test('a division with a missing or nonsensical entry is refused', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const [ name ] = config.shards.map(shard => shard.name);
		assert.strictEqual(await saveShardLimits(db, '100', {}), 'invalid');
		assert.strictEqual(await saveShardLimits(db, '100', { [name!]: -1 }), 'invalid');
		assert.strictEqual(await saveShardLimits(db, '100', { [name!]: 1.5 }), 'invalid');
	});

	test('an accepted division is what a later read returns', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const names = config.shards.map(shard => shard.name);
		const total = await loadAccountCpu(db, '100');
		// Everything on the first shard, nothing on any other
		const division = Object.fromEntries(names.map((name, index) => [ name, index === 0 ? total : 0 ]));
		assert.strictEqual(await saveShardLimits(db, '100', division), null);
		// Spread it: `loadShardLimits` builds a null-prototype object, and the entries are the point
		assert.deepStrictEqual({ ...await loadShardLimits(db, '100') }, division);
	});

	test('a second change inside the cooldown is refused', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		assert.ok(config.runner.cpu.shardLimitsCooldown > 0, 'the default config has a cooldown to test');
		const names = config.shards.map(shard => shard.name);
		const total = await loadAccountCpu(db, '100');
		const division = Object.fromEntries(names.map((name, index) => [ name, index === 0 ? total : 0 ]));
		assert.strictEqual(await saveShardLimits(db, '100', division), null);
		assert.strictEqual(await saveShardLimits(db, '100', division), 'busy');
	});

	test('setShardLimits refuses a division which does not add up', () => {
		const cpu = makeCpu({ shard0: 60, shard1: 40 });
		assert.strictEqual(cpu.setShardLimits({ shard0: 60, shard1: 41 }), C.ERR_INVALID_ARGS);
		assert.strictEqual(cpu.setShardLimits({ shard0: 10, shard1: 10 }), C.ERR_INVALID_ARGS);
		assert.strictEqual(flushShardLimitsRequest(), undefined, 'nothing should reach the driver');
	});

	test('setShardLimits refuses a division which misses a shard or is nonsensical', () => {
		const cpu = makeCpu({ shard0: 60, shard1: 40 });
		assert.strictEqual(cpu.setShardLimits({ shard0: 100 }), C.ERR_INVALID_ARGS);
		assert.strictEqual(cpu.setShardLimits({ shard0: 100, shard2: 0 }), C.ERR_INVALID_ARGS);
		assert.strictEqual(cpu.setShardLimits({ shard0: 100.5, shard1: -0.5 }), C.ERR_INVALID_ARGS);
		assert.strictEqual(flushShardLimitsRequest(), undefined, 'nothing should reach the driver');
	});

	test('setShardLimits hands an accepted division to the driver', () => {
		const cpu = makeCpu({ shard0: 60, shard1: 40 });
		assert.strictEqual(cpu.setShardLimits({ shard0: 0, shard1: 100 }), C.OK);
		assert.deepStrictEqual(flushShardLimitsRequest(), { shard0: 0, shard1: 100 });
		// Reading it clears it, so the next tick doesn't re-apply the same division
		assert.strictEqual(flushShardLimitsRequest(), undefined);
	});

	test('only the last division of a tick reaches the driver', () => {
		const cpu = makeCpu({ shard0: 60, shard1: 40 });
		assert.strictEqual(cpu.setShardLimits({ shard0: 100, shard1: 0 }), C.OK);
		assert.strictEqual(cpu.setShardLimits({ shard0: 0, shard1: 100 }), C.OK);
		// The earlier call was answered but never took effect, so applying it would set a division
		// the player was not told about
		assert.deepStrictEqual(flushShardLimitsRequest(), { shard0: 0, shard1: 100 });
	});

	test('setShardLimits is refused while the cooldown runs', () => {
		const cpu = makeCpu({ shard0: 60, shard1: 40 }, /* cooldown */ 60000);
		assert.strictEqual(cpu.setShardLimits({ shard0: 50, shard1: 50 }), C.ERR_BUSY);
		assert.strictEqual(flushShardLimitsRequest(), undefined, 'nothing should reach the driver');
	});
});
