import { config } from 'xxscreeps/config/index.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { INTER_SHARD_MEMORY_SIZE_LIMIT } from './constants.js';
import { InterShardMemory, flush, initialize, load } from './memory.js';
import { loadSegment, loadSegments, saveSegment } from './model.js';

// The runtime module holds one shard's view for the length of a tick, so each test states the view
// it starts from rather than inheriting whatever the last one left behind.
function asShard(name: string, segments: Record<string, string | null> = {}) {
	initialize(name);
	load(segments);
}

describe('mods/intershardMemory', () => {
	test('a shard which has published nothing reads back nothing', () => {
		asShard('shard0', { shard0: null, shard1: null });
		assert.strictEqual(InterShardMemory.getLocal(), null);
		assert.strictEqual(InterShardMemory.getRemote('shard1'), null);
	});

	test('what was written is what is read back in the same tick', () => {
		asShard('shard0', { shard0: null });
		InterShardMemory.setLocal('hello');
		assert.strictEqual(InterShardMemory.getLocal(), 'hello');
	});

	test('a write is handed over once, and an untouched tick hands over nothing', () => {
		asShard('shard0', { shard0: 'before' });
		assert.strictEqual(flush(), undefined, 'an untouched tick should write nothing');
		InterShardMemory.setLocal('after');
		assert.strictEqual(flush(), 'after');
		assert.strictEqual(flush(), undefined, 'the same value should not be written twice');
	});

	test('a value which is not a string, or is too long, is refused', () => {
		asShard('shard0', { shard0: null });
		assert.throws(() => InterShardMemory.setLocal(42 as never), TypeError);
		assert.throws(() => InterShardMemory.setLocal('x'.repeat(INTER_SHARD_MEMORY_SIZE_LIMIT + 1)));
		// Exactly at the limit is fine
		InterShardMemory.setLocal('x'.repeat(INTER_SHARD_MEMORY_SIZE_LIMIT));
		assert.strictEqual(InterShardMemory.getLocal()?.length, INTER_SHARD_MEMORY_SIZE_LIMIT);
	});

	test('another shard is read through getRemote', () => {
		asShard('shard0', { shard0: 'mine', shard1: 'theirs' });
		assert.strictEqual(InterShardMemory.getLocal(), 'mine');
		assert.strictEqual(InterShardMemory.getRemote('shard1'), 'theirs');
		assert.strictEqual(InterShardMemory.getRemote('shard9'), null, 'an unknown shard reads as empty');
	});

	test('getRemote refuses the shard the code is running on', () => {
		asShard('shard0', { shard0: 'mine' });
		assert.throws(() => InterShardMemory.getRemote('shard0'), /use `getLocal`/);
	});

	test('a segment survives a round trip through storage', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const [ name ] = config.shards.map(shard => shard.name);
		assert.strictEqual(await loadSegment(db, '100', name!), null);
		await saveSegment(db, '100', name!, 'published');
		assert.strictEqual(await loadSegment(db, '100', name!), 'published');
	});

	test('every configured shard has an entry, published or not', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		const segments = await loadSegments(db, '100');
		assert.deepStrictEqual(Object.keys(segments), config.shards.map(shard => shard.name));
		assert.ok(Object.values(segments).every(value => value === null));
	});
});
