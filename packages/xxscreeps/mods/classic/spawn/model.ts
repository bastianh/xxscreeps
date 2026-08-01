import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { userToPresenceRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { StructureSpawn } from './spawn.js';

/**
 * `empty` means the player has nothing left in the world and must pick a starting room. `lost`
 * means they still hold something, but no longer have a base to play from, so the client offers a
 * respawn. `normal` is business as usual.
 */
export type WorldStatus = 'empty' | 'lost' | 'normal';

/**
 * A player is in the game as long as they hold at least one spawn in a room they control. As soon
 * as the last one is destroyed the game is over for them, even though the controller and whatever
 * else survived the attack still belongs to them.
 */
export async function getWorldStatus(shard: Shard, userId: string): Promise<WorldStatus> {
	const [ presence, controlledRooms ] = await Promise.all([
		shard.scratch.sCard(userToPresenceRoomsSetKey(userId)),
		shard.scratch.sMembers(controlledRoomsKey(userId)),
	]);
	if (presence === 0) {
		return 'empty';
	}
	// Only the objects are needed, so the room indices are left uninitialized
	const rooms = await Promise.all(Fn.map(controlledRooms, roomName => shard.loadRoom(roomName, undefined, true)));
	const hasSpawn = Fn.some(rooms, room => Fn.some(
		room['#objects'],
		object => object instanceof StructureSpawn && object['#user'] === userId));
	return hasSpawn ? 'normal' : 'lost';
}
