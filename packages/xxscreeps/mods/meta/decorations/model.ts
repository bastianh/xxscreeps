import type { DecorationDefinition } from './catalog.js';
import type { Placement } from './placement.js';
import type { Database } from 'xxscreeps/engine/db/index.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import { Channel } from 'xxscreeps/engine/db/channel.js';
import { hooks as userHooks } from 'xxscreeps/engine/db/user/index.js';
import { generateId } from 'xxscreeps/engine/schema/id.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { controlledRoomsKey, reservedRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { catalog } from './catalog.js';
import { conflicts, decodeProps, encodeProps } from './placement.js';

// Who owns which decoration, and where they put it. Ownership is an account fact, not a shard fact,
// so it lives in the shared `db.data` store next to the other per-user records — `active.shard`
// says which shard a placement points at.
//
// With `decorations.grantAll` (the default) the whole catalog is owned by everybody and no grant is
// read from the store at all — the natural setup for a private server, where decorations are a
// customisation option rather than something to earn. Explicit grants are still written and kept;
// they take effect once `grantAll` is turned off. Placements are stored either way.

/** set: ids of the inventory items `userId` was granted. */
const inventoryKey = (userId: string) => `user/${userId}/decorations`;
/** hash: `{ def, createdAt }` of one granted item. */
const itemKey = (userId: string, itemId: string) => `user/${userId}/decorations/${itemId}`;
/** hash: `{ activatedAt, shard, room, prop/… }` of one placed item. Absent when it is not placed. */
const activeKey = (userId: string, itemId: string) => `user/${userId}/decorations/${itemId}/active`;
/** set: ids `userId` has placed. Saves asking after every item they own, which under `grantAll` is
 * the whole catalog. */
const activeIndexKey = (userId: string) => `user/${userId}/decorations/active`;
/** set: `userId/itemId` of everything placed in one room. Drives the room and map queries. */
const roomIndexKey = (shard: string, room: string) => `decorations/${shard}/${room}`;
/** set: `userId/itemId` of the creep decorations, which follow their owner instead of a room. */
const globalIndexKey = 'decorations/global';

export const grantAll = () => config.decorations?.grantAll ?? true;

/**
 * Announces that what is placed in a room changed, so open room sockets re-read it. Creep
 * decorations show up in every room, so they get their own channel that all of them watch.
 */
export const getRoomDecorationChannel = (db: Database, shardName: string, room: string) =>
	new Channel<DecorationUpdate>(db.pubsub, roomIndexKey(shardName, room));
export const getGlobalDecorationChannel = (db: Database) =>
	new Channel<DecorationUpdate>(db.pubsub, globalIndexKey);

export interface DecorationUpdate {
	type: 'updated';
}

/** One decoration a user owns, resolved against the catalog. */
export interface OwnedDecoration {
	id: string;
	definition: DecorationDefinition;
	/** Epoch milliseconds. Absent for the implicit ownership `grantAll` hands out. */
	createdAt?: number;
	/** Where it is placed, or absent while it sits unplaced in the inventory. */
	active?: Placement;
	/** Epoch milliseconds it was placed. */
	activatedAt?: number;
}

const indexMember = (userId: string, itemId: string) => `${userId}/${itemId}`;

/** Ids never contain a slash, so the first one separates the two halves. */
function parseIndexMember(member: string) {
	const slash = member.indexOf('/');
	return { userId: member.slice(0, slash), itemId: member.slice(slash + 1) };
}

/** The placement of one item, or `undefined` when it is not placed. */
async function loadPlacement(db: Database, userId: string, itemId: string, definition: DecorationDefinition) {
	const fields = await db.data.hGetAll(activeKey(userId, itemId));
	if (fields.activatedAt === undefined) {
		return;
	}
	const placement: Placement = {
		...fields.shard !== undefined && { shard: fields.shard },
		...fields.room !== undefined && { room: fields.room },
		props: decodeProps(definition, fields),
	};
	return { placement, activatedAt: Number(fields.activatedAt) };
}

/**
 * The definition behind an item `userId` owns, or `undefined` when they do not own it.
 *
 * Under `grantAll` an item has no stored grant, so the id names the decoration directly — which is
 * exactly what {@link listForUser} hands the client in that mode.
 */
export async function ownedDefinition(db: Database, userId: string, itemId: string) {
	const def = await db.data.hGet(itemKey(userId, itemId), 'def');
	if (def !== null) {
		return catalog.definitions.get(def);
	}
	return grantAll() ? catalog.definitions.get(itemId) : undefined;
}

/**
 * Everything `userId` owns.
 *
 * A stored item whose definition is gone — its pack was unloaded — is left in the store but kept
 * out of the listing; the grant becomes visible again once the pack is back.
 */
export async function listForUser(db: Database, userId: string): Promise<OwnedDecoration[]> {
	const owned = await async function(): Promise<OwnedDecoration[]> {
		if (grantAll()) {
			// Implicit ownership has no record to carry an id, so the decoration's own id names the
			// item. That keeps the id stable across restarts, which is what the client needs to
			// place and remove one.
			return [ ...Fn.map(catalog.definitions.values(), definition => ({ id: definition._id, definition })) ];
		}
		const ids = await db.data.sMembers(inventoryKey(userId));
		const items = await Fn.mapAwait(ids, async (id): Promise<OwnedDecoration | undefined> => {
			const fields = await db.data.hGetAll(itemKey(userId, id));
			const definition = catalog.definitions.get(fields.def!);
			if (definition === undefined) {
				console.warn(`User ${userId} owns decoration '${fields.def}', which no loaded pack defines`);
				return;
			}
			return { id, definition, createdAt: Number(fields.createdAt) };
		});
		return [ ...Fn.filter(items) ];
	}();
	const placedIds = new Set(await db.data.sMembers(activeIndexKey(userId)));
	return Fn.mapAwait(owned, async (item): Promise<OwnedDecoration> => {
		if (!placedIds.has(item.id)) {
			return item;
		}
		const placed = await loadPlacement(db, userId, item.id, item.definition);
		return { ...item, ...placed !== undefined && { active: placed.placement, activatedAt: placed.activatedAt } };
	});
}

/** One decoration standing in a room, as the room and map views report it. */
export interface PlacedDecoration {
	id: string;
	userId: string;
	definition: DecorationDefinition;
	active: Placement;
	activatedAt: number;
}

/** Everything placed in one room, across all users, plus the creep decorations that ride along. */
export async function listForRoom(db: Database, shardName: string, room: string): Promise<PlacedDecoration[]> {
	const [ placed, global ] = await Promise.all([
		db.data.sMembers(roomIndexKey(shardName, room)),
		db.data.sMembers(globalIndexKey),
	]);
	const items = await Fn.mapAwait(Fn.concat<string>([ placed, global ]), async member => {
		const { userId, itemId } = parseIndexMember(member);
		const definition = await ownedDefinition(db, userId, itemId);
		if (definition === undefined) {
			return;
		}
		const found = await loadPlacement(db, userId, itemId, definition);
		if (found === undefined) {
			return;
		}
		return { id: itemId, userId, definition, active: found.placement, activatedAt: found.activatedAt };
	});
	return [ ...Fn.filter(items) ];
}

/** Give `userId` a decoration from the catalog. Returns the id of the new inventory item. */
export async function grant(db: Database, userId: string, definitionId: string) {
	if (!catalog.definitions.has(definitionId)) {
		throw new Error(`No such decoration: ${definitionId}`);
	}
	const id = generateId(12);
	await Promise.all([
		db.data.sAdd(inventoryKey(userId), [ id ]),
		db.data.hmSet(itemKey(userId, id), { def: definitionId, createdAt: Date.now() }),
	]);
	return id;
}

/** Take an inventory item away again. Returns false if the user didn't have it. */
export async function revoke(db: Database, userId: string, itemId: string) {
	await deactivate(db, userId, [ itemId ]);
	const [ removed ] = await Promise.all([
		db.data.sRem(inventoryKey(userId), [ itemId ]),
		db.data.del(itemKey(userId, itemId)),
	]);
	return removed > 0;
}

/** Whether `userId` holds or reserves `room`, which placing something there requires. */
async function controlsRoom(shard: Shard, userId: string, room: string) {
	const [ controlled, reserved ] = await Promise.all([
		shard.scratch.sIsMember(controlledRoomsKey(userId), room),
		shard.scratch.sIsMember(reservedRoomsKey(userId), room),
	]);
	return controlled || reserved;
}

/**
 * Place an item, replacing wherever it sat before. The client relies on the replacement: it moves a
 * decoration by activating it again at the new spot.
 */
export async function activate(
	db: Database, shard: Shard, userId: string, itemId: string, placement: Placement,
): Promise<{ error: string } | undefined> {
	const definition = await ownedDefinition(db, userId, itemId);
	if (definition === undefined) {
		return { error: 'not owned' };
	}
	const { room } = placement;
	if (room !== undefined) {
		if (placement.shard !== shard.name) {
			return { error: 'unknown shard' };
		} else if (!await shard.data.sIsMember('rooms', room)) {
			return { error: 'unknown room' };
		} else if ((config.decorations?.requireRoomOwnership ?? true) && !await controlsRoom(shard, userId, room)) {
			return { error: 'room not controlled' };
		}
		const roommates = await listForRoom(db, shard.name, room);
		const blocked = roommates.some(other =>
			other.userId === userId && other.id !== itemId && conflicts(definition, other.definition));
		if (blocked) {
			return { error: 'already decorated' };
		}
	}

	// Moving an item out of its old room has to happen before the new placement is indexed,
	// otherwise a move within one room would drop the entry it just wrote.
	await deactivate(db, userId, [ itemId ]);
	const index = room === undefined ? globalIndexKey : roomIndexKey(shard.name, room);
	await Promise.all([
		db.data.hmSet(activeKey(userId, itemId), {
			activatedAt: Date.now(),
			...placement.shard !== undefined && { shard: placement.shard },
			...room !== undefined && { room },
			...encodeProps(placement.props),
		}),
		db.data.sAdd(index, [ indexMember(userId, itemId) ]),
		db.data.sAdd(activeIndexKey(userId), [ itemId ]),
		announce(db, placement.shard, room),
	]);
	return undefined;
}

/** Tell open room sockets to re-read. Fired alongside the write, since reads are not synchronized. */
const announce = (db: Database, shardName: string | undefined, room: string | undefined) =>
	shardName === undefined || room === undefined
		? getGlobalDecorationChannel(db).publish({ type: 'updated' })
		: getRoomDecorationChannel(db, shardName, room).publish({ type: 'updated' });

/** Take items off the map. Unknown or already-unplaced ids are left alone. */
export async function deactivate(db: Database, userId: string, itemIds: Iterable<string>) {
	await Fn.mapAwait(itemIds, async itemId => {
		const fields = await db.data.hGetAll(activeKey(userId, itemId));
		if (fields.activatedAt === undefined) {
			return;
		}
		const index = fields.room === undefined || fields.shard === undefined
			? globalIndexKey
			: roomIndexKey(fields.shard, fields.room);
		await Promise.all([
			db.data.del(activeKey(userId, itemId)),
			db.data.sRem(index, [ indexMember(userId, itemId) ]),
			db.data.sRem(activeIndexKey(userId), [ itemId ]),
			announce(db, fields.shard, fields.room),
		]);
	});
}

async function removeAllForUser(db: Database, userId: string) {
	const [ ids, placed ] = await Promise.all([
		db.data.sMembers(inventoryKey(userId)),
		db.data.sMembers(activeIndexKey(userId)),
	]);
	// Implicit grants have no inventory entry, so placements are tracked separately from ownership.
	await deactivate(db, userId, placed);
	await Promise.all([
		db.data.del(inventoryKey(userId)),
		db.data.del(activeIndexKey(userId)),
		...Fn.map(ids, id => db.data.del(itemKey(userId, id))),
	]);
}

// Tear down a removed user's decorations as part of `User.remove`.
userHooks.register('remove', removeAllForUser);
