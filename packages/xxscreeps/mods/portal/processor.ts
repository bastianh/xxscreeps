import type { RemotePortalDestination } from './portal.js';
import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { readRoomObject } from 'xxscreeps/engine/db/room.js';
import { registerIntentProcessor, registerObjectTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { makePositionChecker } from 'xxscreeps/game/pathfinder/obstacle.js';
import { RoomPosition, iterateNeighbors } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import { detachCreep, teleportCreep } from 'xxscreeps/mods/classic/creep/processor.js';
import { latin1ToBuffer } from 'xxscreeps/utility/string.js';
import { sendObjectToShard } from './model.js';
import { StructurePortal } from './portal.js';

// A creep arriving from another shard has no position of its own -- the shards' rooms are unrelated
// grids -- so it lands beside a portal pointing back the way it came, and failing that on any free
// square. Mirrors the vanilla rule that arrival coordinates are undetermined.
export function findArrivalPosition(room: Room, userId: string) {
	const isFree = makePositionChecker({ checkTerrain: true, room, user: userId });
	const returnPortals = [ ...function*() {
		for (const object of room['#objects']) {
			if (object instanceof StructurePortal && object.destination.shard !== undefined) {
				yield object;
			}
		}
	}() ];
	for (const portal of returnPortals) {
		for (const pos of iterateNeighbors(portal.pos)) {
			if (isFree(pos)) {
				return pos;
			}
		}
	}
	for (let yy = 1; yy < 49; ++yy) {
		for (let xx = 1; xx < 49; ++xx) {
			const pos = new RoomPosition(xx, yy, room.name);
			if (isFree(pos)) {
				return pos;
			}
		}
	}
}

export type PortalIntents = [ typeof intents ];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const intents = registerIntentProcessor(Room, 'importFromShard', { internal: true }, (
	room: Room, context: ProcessorContext, objectPayload: string, delta: number, userId: string,
) => {
	const object = readRoomObject(latin1ToBuffer(objectPayload));
	// Tick-absolute fields were written against the departure shard's clock, which has nothing to do
	// with this one's. Shifting by the difference preserves what the player actually observes --
	// `ticksToLive` is `#ageTime - Game.time`, so the same subtraction survives the move.
	if (object instanceof Creep) {
		if (object['#ageTime'] !== 0) {
			object['#ageTime'] += delta;
		}
		// A `saying` belongs to the tick it was said in, which is gone
		object['#saying'] = undefined;
	}
	const pos = findArrivalPosition(room, userId);
	if (pos === undefined) {
		// The room is full. The creep is gone either way; dropping it beats corrupting the room.
		return;
	}
	object.pos = pos;
	room['#insertObject'](object);
	context.didUpdate();
});

// Hands a creep standing on an inter-shard portal to the destination shard's queue. The creep
// leaves this room now and appears on the other shard whenever its `main` next drains the queue --
// the two clocks are independent, so there is no tick at which a direct hand-off would be safe.
function departToShard(creep: Creep, destination: RemotePortalDestination, context: ProcessorContext) {
	const userId = creep['#user'];
	const payload = detachCreep(creep, new RoomPosition(25, 25, destination.room), context);
	if (payload !== undefined) {
		context.task(sendObjectToShard(context.shard.db, destination.shard, {
			room: destination.room,
			// `state.time` is the tick the creep leaves for, matching the tick its arrival is queued
			// against on the other side, so the difference between the two is exact.
			time: context.state.time,
			userId,
			payload,
		}));
	}
}

registerObjectTickProcessor(StructurePortal, (portal, context) => {
	if (portal.ticksToDecay === 0) {
		portal.room['#removeObject'](portal);
		context.didUpdate();
		return;
	} else {
		context.wakeAt(portal['#decayTime']);
	}

	const dest = portal.destination;
	for (const object of portal.room['#lookAt'](portal.pos)) {
		if (object instanceof Creep && object['#user'].length > 2) {
			if (dest.shard === undefined) {
				teleportCreep(object, dest, context);
			} else {
				departToShard(object, dest, context);
			}
		}
	}
});
