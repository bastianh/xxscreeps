import type { Room } from 'xxscreeps/game/room/index.js';
import { writeRoomObject } from 'xxscreeps/engine/db/room.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { instanceOfPredicate } from 'xxscreeps/functional/predicate.js';
import { World } from 'xxscreeps/game/map.js';
import { RoomPosition, iterateAllPositions } from 'xxscreeps/game/position.js';
import { isBorder } from 'xxscreeps/game/terrain.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { lookForStructures } from 'xxscreeps/mods/classic/structure/structure.js';
import { exportPayload, importPayload } from 'xxscreeps/scripts/payload.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { typedArrayToString } from 'xxscreeps/utility/string.js';
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

	test('arrivals do not stack on an occupied square', () => simulate({
		// No portal leading back, so placement falls through to the open-square search
		W1N1: () => {},
	})(async ({ peekRoom }) => {
		await peekRoom('W1N1', room => {
			const first = findArrivalPosition(room, '100');
			assert.ok(first, 'an arrival position should be found');
			// Stand on it, exactly as the previous arrival would
			room['#insertObject'](createCreep(first, [ C.MOVE ], 'squatter', '100'));
			room['#flushObjects'](null);
			const second = findArrivalPosition(room, '100');
			assert.ok(second, 'a second arrival should still find somewhere to stand');
			assert.ok(!second.isEqualTo(first), `second arrival stacked on ${second.x},${second.y}`);
		});
	}));

	test('a creep through a same-shard portal is indexed where it stands', () => simulate({
		W1N1: room => {
			room['#insertObject'](createPortal(
				new RoomPosition(25, 25, 'W1N1'),
				new RoomPosition(20, 20, 'W2N2'),
			));
			room['#insertObject'](createCreep(
				new RoomPosition(25, 25, 'W1N1'), [ C.MOVE ], 'traveler', '100'));
		},
	})(async ({ peekRoom, tick }) => {
		await tick();
		await peekRoom('W2N2', room => {
			const creep = room.find(C.FIND_CREEPS).find(object => object.name === 'traveler');
			assert.ok(creep, 'creep should have arrived');
			assert.ok(creep.pos.isEqualTo(20, 20));
			// The spatial index is what collision and `lookAt` read; it must agree with `pos`
			const here = room['#lookAt'](new RoomPosition(20, 20, 'W2N2'));
			assert.ok([ ...here ].includes(creep), 'creep is not indexed at the position it occupies');
		});
	}));

	test('successive arrivals from another shard land on different squares', () => simulate({
		W1N1: () => {},
	})(async ({ shard, tick, peekRoom }) => {
		const arrive = async (name: string) => {
			// Built inside the game context, the way a departing shard would have written it
			const payload = await peekRoom('W1N1', (room, game) => {
				const creep = createCreep(new RoomPosition(25, 25, 'W1N1'), [ C.MOVE ], name, '100');
				creep['#ageTime'] = game.time + 1000;
				return typedArrayToString(writeRoomObject(creep));
			});
			await pushIntentsForRoomNextTick(shard, 'W1N1', '100', {
				internal: true,
				local: { importFromShard: [ [ payload, 0, '100' ] ] },
			});
			// The intent is queued for the next tick, and the queue for that tick is built by the one
			// after, so the arrival lands two ticks out
			await tick(2);
		};
		await arrive('first');
		await arrive('second');
		await peekRoom('W1N1', room => {
			const arrivals = room.find(C.FIND_CREEPS).filter(creep => creep.name === 'first' || creep.name === 'second');
			assert.strictEqual(arrivals.length, 2, 'both arrivals should be in the room');
			assert.ok(!arrivals[0]!.pos.isEqualTo(arrivals[1]!.pos),
				`arrivals stacked at ${arrivals[0]!.pos.x},${arrivals[0]!.pos.y}`);
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

	// A permanent portal on plain, a stable one on swamp, and a decaying one.
	const kUnstableTime = Date.UTC(2026, 9, 15);
	const lifecycles = simulate({
		W1N1: room => {
			const terrain = room.getTerrain();
			const interiorOn = (value: number) => Fn.filter(iterateAllPositions(room.name), pos =>
				!isBorder(pos.x, pos.y) && terrain.get(pos.x, pos.y) === value);
			const [ permanentPos, decayingPos ] = interiorOn(0);
			const [ stablePos ] = interiorOn(C.TERRAIN_MASK_SWAMP);
			assert.ok(permanentPos && decayingPos && stablePos);
			room['#insertObject'](createPortal(permanentPos, new RoomPosition(30, 30, 'W2N2')));
			room['#insertObject'](createPortal(decayingPos, new RoomPosition(31, 31, 'W2N2'), /* decayTime */ 100));
			const stable = createPortal(stablePos, { shard: 'shard1', room: 'W5N5' });
			stable['#unstableTime'] = kUnstableTime;
			room['#insertObject'](stable);
		},
	});

	test('payload round trip', () => lifecycles(async ({ shard }) => {
		const { payload, dropped } = await exportPayload(shard);
		// The decaying portal's tick means nothing in another world, so it stays behind.
		assert.strictEqual(dropped.filter(instanceOfPredicate(StructurePortal)).length, 1);
		const { rooms, terrain } = importPayload(payload);
		const portals = lookForStructures(rooms.find(room => room.name === 'W1N1'), C.STRUCTURE_PORTAL);
		assert.strictEqual(portals.length, 2);
		// Each one stands on the ground it was exported from.
		const roomTerrain = new World('test', terrain).map.getRoomTerrain('W1N1');

		const permanent = portals.find(portal => portal.destination.shard === undefined);
		assert.ok(permanent?.destination instanceof RoomPosition);
		assert.ok(permanent.destination.isEqualTo(new RoomPosition(30, 30, 'W2N2')));
		assert.strictEqual(permanent['#unstableTime'], 0);
		assert.strictEqual(roomTerrain.get(permanent.pos.x, permanent.pos.y), 0);

		const stable = portals.find(portal => portal.destination.shard !== undefined);
		assert.deepStrictEqual(stable?.destination, { shard: 'shard1', room: 'W5N5' });
		assert.strictEqual(stable['#unstableTime'], kUnstableTime);
		assert.strictEqual(roomTerrain.get(stable.pos.x, stable.pos.y), C.TERRAIN_MASK_SWAMP);
	}));
});
