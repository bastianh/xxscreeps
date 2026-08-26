import type { Database } from 'xxscreeps/engine/db/index.js';
import { consumeList } from 'xxscreeps/engine/db/async.js';

/**
 * An object in flight between two shards.
 *
 * The queue lives in the global database rather than in either shard's storage, so neither side
 * needs a connection to the other: the departing room's processor appends to the destination's
 * queue, and that shard's `main` drains it while it holds the game mutex. Shards tick
 * independently, so there is no moment at which a direct hand-off would be safe -- writing into the
 * destination's scratch would race whatever tick it happens to be in the middle of.
 */
export interface ShardTransfer {
	/** Room on the destination shard the object is bound for */
	room: string;
	/**
	 * Tick on the shard the object left. Fields like a creep's `#ageTime` are absolute ticks, and
	 * the two shards' clocks are unrelated, so the destination rebases them by the difference.
	 */
	time: number;
	/** Owner, so the arrival can be attributed without decoding the payload */
	userId: string;
	/** `writeRoomObject` payload, latin1-encoded the way the `import` intent already carries one */
	payload: string;
}

const transferKey = (shardName: string) => `interShard/${shardName}/inbound`;

export function sendObjectToShard(db: Database, shardName: string, transfer: ShardTransfer) {
	return db.data.rPush(transferKey(shardName), [ JSON.stringify(transfer) ]);
}

export function consumeObjectsForShard(db: Database, shardName: string) {
	return consumeList(db.data, transferKey(shardName));
}
