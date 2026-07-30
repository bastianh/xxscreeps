import type { DecorationDefinition } from './catalog.js';
import type { Database } from 'xxscreeps/engine/db/index.js';
import { config } from 'xxscreeps/config/index.js';
import { hooks as userHooks } from 'xxscreeps/engine/db/user/index.js';
import { generateId } from 'xxscreeps/engine/schema/id.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { catalog } from './catalog.js';

// Who owns which decoration. Ownership is an account fact, not a shard fact, so it lives in the
// shared `db.data` store next to the other per-user records.
//
// With `decorations.grantAll` (the default) the whole catalog is owned by everybody and nothing is
// read from the store at all — the natural setup for a private server, where decorations are a
// customisation option rather than something to earn. Explicit grants are still written and kept;
// they take effect once `grantAll` is turned off.

/** set: ids of the inventory items `userId` was granted. */
const inventoryKey = (userId: string) => `user/${userId}/decorations`;
/** hash: `{ def, createdAt }` of one granted item. */
const itemKey = (userId: string, itemId: string) => `user/${userId}/decorations/${itemId}`;

export const grantAll = () => config.decorations?.grantAll ?? true;

/** One decoration a user owns, resolved against the catalog. */
export interface OwnedDecoration {
	id: string;
	definition: DecorationDefinition;
	/** Epoch milliseconds. Absent for the implicit ownership `grantAll` hands out. */
	createdAt?: number;
}

/**
 * Everything `userId` owns.
 *
 * A stored item whose definition is gone — its pack was unloaded — is left in the store but kept
 * out of the listing; the grant becomes visible again once the pack is back.
 */
export async function listForUser(db: Database, userId: string): Promise<OwnedDecoration[]> {
	if (grantAll()) {
		// Implicit ownership has no record to carry an id, so the decoration's own id names the
		// item. That keeps the id stable across restarts, which is what the client needs to place
		// and remove one.
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
	const [ removed ] = await Promise.all([
		db.data.sRem(inventoryKey(userId), [ itemId ]),
		db.data.del(itemKey(userId, itemId)),
	]);
	return removed > 0;
}

async function removeAllForUser(db: Database, userId: string) {
	const ids = await db.data.sMembers(inventoryKey(userId));
	await Promise.all([
		db.data.del(inventoryKey(userId)),
		...Fn.map(ids, id => db.data.del(itemKey(userId, id))),
	]);
}

// Tear down a removed user's decorations as part of `User.remove`.
userHooks.register('remove', removeAllForUser);
