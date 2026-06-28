import { setGamePaused } from 'xxscreeps/engine/service/control.js';
import { getServiceChannel } from 'xxscreeps/engine/service/index.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { getGameStatus, pauseGame, resumeGame } from './game.js';
import { shutdown } from './shutdown.js';
import { getTerrain, patchTerrain, putTerrain } from './terrain.js';

describe('Admin API game control', () => {
	test('reports pause status and tick', () => simulate({})(async ({ shard }) => {
		assert.deepStrictEqual(await getGameStatus(shard), {
			ok: 1,
			paused: false,
			tick: shard.time,
		});
		await setGamePaused(shard, true);
		assert.deepStrictEqual(await getGameStatus(shard), {
			ok: 1,
			paused: true,
			tick: shard.time,
		});
	}));

	test('pauses and resumes game', () => simulate({})(async ({ shard }) => {
		assert.deepStrictEqual(await pauseGame(shard), {
			ok: 1,
			paused: true,
			tick: shard.time,
		});
		assert.deepStrictEqual(await getGameStatus(shard), {
			ok: 1,
			paused: true,
			tick: shard.time,
		});
		assert.deepStrictEqual(await resumeGame(shard), {
			ok: 1,
			paused: false,
			tick: shard.time,
		});
		assert.deepStrictEqual(await getGameStatus(shard), {
			ok: 1,
			paused: false,
			tick: shard.time,
		});
	}));
});

describe('Admin API terrain', () => {
	test('GET returns terrain string', () => simulate({})(async ({ shard }) => {
		const result = await getTerrain(shard, 'W1N1');
		assert.strictEqual(result.ok, 1);
		assert.strictEqual(result.room, 'W1N1');
		assert.strictEqual(result.terrain.length, 2500);
	}));

	test('writes require paused game', () => simulate({})(async ({ shard }) => {
		const result = await patchTerrain(shard, 'W1N1', {
			tiles: [ { x: 25, y: 25, terrain: 'wall' } ],
		});
		assert.deepStrictEqual(result, { error: 'game must be paused' });
	}));

	test('PATCH updates only listed tiles', () => simulate({})(async ({ shard }) => {
		await setGamePaused(shard, true);
		const before = await getTerrain(shard, 'W1N1');
		const result = await patchTerrain(shard, 'W1N1', {
			tiles: [
				{ x: 3, y: 4, terrain: 'wall' },
				{ x: 4, y: 4, terrain: 2 },
			],
		});
		const after = await getTerrain(shard, 'W1N1');
		assert.deepStrictEqual(result, { ok: 1, restartRequired: true });
		if (!('terrain' in before) || !('terrain' in after)) {
			assert.fail('expected terrain payloads');
		}
		assert.strictEqual(after.terrain[4 * 50 + 3], '1');
		assert.strictEqual(after.terrain[4 * 50 + 4], '2');
		assert.strictEqual(after.terrain.slice(0, 4 * 50 + 3), before.terrain.slice(0, 4 * 50 + 3));
		assert.strictEqual(after.terrain.slice(4 * 50 + 5), before.terrain.slice(4 * 50 + 5));
	}));

	test('PUT validates terrain', () => simulate({})(async ({ shard }) => {
		await setGamePaused(shard, true);
		assert.deepStrictEqual(await putTerrain(shard, 'W1N1', { terrain: '0'.repeat(2499) }), { error: 'invalid terrain' });
		assert.deepStrictEqual(await putTerrain(shard, 'W1N1', { terrain: `${'0'.repeat(2499)}x` }), { error: 'invalid terrain' });
	}));

	test('PUT updates exits when borders change', () => simulate({})(async ({ shard }) => {
		await setGamePaused(shard, true);
		const allWalls = '1'.repeat(2500);
		const result = await putTerrain(shard, 'W1N1', { terrain: allWalls });
		assert.deepStrictEqual(result, { ok: 1, restartRequired: true });
		const world = await shard.loadWorld();
		assert.strictEqual(Object.keys(world.map.describeExits('W1N1')!).length, 0);
	}));

	test('validates room names, tile coordinates, and terrain values', () => simulate({})(async ({ shard }) => {
		await setGamePaused(shard, true);
		assert.deepStrictEqual(await getTerrain(shard, 'not-a-room'), { error: 'invalid room' });
		assert.deepStrictEqual(await patchTerrain(shard, 'W1N1', { tiles: [ { x: -1, y: 0, terrain: 'plain' } ] }), { error: 'invalid tile' });
		assert.deepStrictEqual(await patchTerrain(shard, 'W1N1', { tiles: [ { x: 0, y: 0, terrain: 'lava' } ] }), { error: 'invalid tile' });
	}));
});

describe('Admin API shutdown', () => {
	test('requires paused game', () => simulate({})(async ({ db, shard }) => {
		const result = await shutdown(db, shard, () => {});
		assert.deepStrictEqual(result, { error: 'game must be paused' });
	}));

	test('publishes shutdown and schedules process exit', () => simulate({})(async ({ db, shard }) => {
		await setGamePaused(shard, true);
		let didSchedule = false;
		const [ cancel, message ] = getServiceChannel(shard).listenFor(message => message.type === 'shutdown');
		try {
			const result = await shutdown(db, shard, () => didSchedule = true);
			assert.deepStrictEqual(result, { ok: 1, shuttingDown: true });
			assert.strictEqual(didSchedule, true);
			const shutdownMessage = await message;
			assert.ok(shutdownMessage);
			assert.strictEqual(shutdownMessage.type, 'shutdown');
		} finally {
			cancel();
		}
	}));
});
