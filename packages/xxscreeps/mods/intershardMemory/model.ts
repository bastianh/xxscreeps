import type { Database } from 'xxscreeps/engine/db/index.js';
import { config } from 'xxscreeps/config/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';

// Every shard writes one string and reads all of them, so the segments live in the global database
// rather than in any one shard's. A shard's runner is the only writer of its own entry.
const segmentKey = (userId: string, shardName: string) => `user/${userId}/interShard/${shardName}`;

export function loadSegment(db: Database, userId: string, shardName: string) {
	return db.data.get(segmentKey(userId, shardName));
}

export async function loadSegments(db: Database, userId: string) {
	const entries = await Fn.mapAwait(config.shards, async ({ name }) =>
		[ name, await loadSegment(db, userId, name) ] as const);
	return Fn.fromEntries(entries);
}

export function saveSegment(db: Database, userId: string, shardName: string, value: string) {
	return db.data.set(segmentKey(userId, shardName), value);
}

export function deleteSegments(db: Database, userId: string) {
	return Promise.all(Fn.map(config.shards, ({ name }) => db.data.vDel(segmentKey(userId, name))));
}
