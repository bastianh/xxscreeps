import type { Room } from 'xxscreeps/game/room/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { StructurePortal, create as createPortal } from './portal.js';
import { findArrivalPosition } from './processor.js';

const findPortal = (room: Room) =>
	room.find(C.FIND_STRUCTURES).find(object => object instanceof StructurePortal);

describe('mods/portal', () => {
	test('decaying portal exposes positive ticksToDecay', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(30, 30, 'W2N2'),
				/* decayTime */ 100,
			));
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', (room, game) => {
			const portal = findPortal(room);
			assert.ok(portal, 'portal should exist');
			const ttd = portal.ticksToDecay;
			assert.ok(typeof ttd === 'number' && ttd > 0 && ttd <= 100,
				`ticksToDecay should count down from #decayTime; got ${ttd}`);
			assert.strictEqual(ttd, 100 - game.time);
		});
	}));

	test('permanent portal has undefined ticksToDecay', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(30, 30, 'W2N2'),
				/* decayTime */ 0,
			));
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const portal = findPortal(room);
			assert.ok(portal, 'permanent portal should exist');
			assert.strictEqual(portal.ticksToDecay, undefined);
		});
	}));

	test('same-shard destination is a RoomPosition with x/y/roomName', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(17, 23, 'W3N3'),
			));
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const portal = findPortal(room);
			assert.ok(portal, 'portal should exist');
			const dest = portal.destination;
			assert.ok(dest instanceof RoomPosition);
			assert.strictEqual(dest.roomName, 'W3N3');
			assert.strictEqual(dest.x, 17);
			assert.strictEqual(dest.y, 23);
		});
	}));

	test('cross-shard destination is { shard, room }', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				{ shard: 'shard1', room: 'W5N5' },
			));
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const portal = findPortal(room);
			assert.ok(portal, 'portal should exist');
			assert.deepStrictEqual(portal.destination, { shard: 'shard1', room: 'W5N5' });
		});
	}));

	test('arrivals land beside a portal leading back', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				{ shard: 'shard1', room: 'W5N5' },
			));
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const pos = findArrivalPosition(room, '100');
			assert.ok(pos, 'an arrival position should be found');
			assert.ok(pos.getRangeTo(25, 25) === 1, `expected a square beside the portal, got ${pos.x},${pos.y}`);
		});
	}));

	test('arrivals do not stack on occupied squares', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				{ shard: 'shard1', room: 'W5N5' },
			));
			// Wall the portal in with creeps, so every square it would prefer is taken
			let index = 0;
			for (let yy = 24; yy <= 26; ++yy) {
				for (let xx = 24; xx <= 26; ++xx) {
					if (xx !== 25 || yy !== 25) {
						room['#insertObject'](createCreep(
							new RoomPosition(xx, yy, 'W1N1'), [ C.MOVE ], `squatter${index++}`, '100'));
					}
				}
			}
		},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const pos = findArrivalPosition(room, '100');
			assert.ok(pos, 'a crowded portal should still yield somewhere to stand');
			assert.ok(pos.getRangeTo(25, 25) > 1, `arrival stacked on an occupied square at ${pos.x},${pos.y}`);
		});
	}));

	test('overlapping portals only import a creep once', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(20, 20, 'W2N2'),
			));
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(21, 21, 'W2N2'),
			));
			room['#insertObject'](createCreep(
				new RoomPosition(25, 25, 'W1N1'),
				[ C.MOVE ],
				'traveler',
				'100',
			));
		},
	})(async ({ peekRoom, tick }) => {
		await tick();
		await peekRoom('W2N2', room => {
			const creeps = room.find(C.FIND_CREEPS).filter(creep => creep.name === 'traveler');
			assert.strictEqual(creeps.length, 1);
			assert.ok(creeps[0]?.pos.isEqualTo(20, 20));
		});
		await peekRoom('W1N1', room => {
			assert.strictEqual(room.find(C.FIND_CREEPS).length, 0);
		});
	}));
});
