import { INTER_SHARD_MEMORY_SIZE_LIMIT } from './constants.js';

// What every shard published, as of the tick this one started. The local entry is kept separately
// because a write during the tick has to be visible to the code that made it.
let segments: Record<string, string | null> = {};
let shardName = '';
let local: string | null = null;
let dirty = false;

/** @internal */
export function initialize(name: string) {
	shardName = name;
}

/** @internal */
export function load(payload: Record<string, string | null>) {
	segments = payload;
	local = payload[shardName] ?? null;
	dirty = false;
}

/** @internal */
export function flush() {
	if (dirty) {
		dirty = false;
		return local ?? '';
	}
}

/**
 * Access to the in-memory segment shared between shards.
 * @public
 * @see https://docs.screeps.com/api/#InterShardMemory
 */
export const InterShardMemory = {
	/**
	 * Returns the string contents of the current shard's data.
	 * @public
	 * @see https://docs.screeps.com/api/#InterShardMemory.getLocal
	 */
	getLocal() {
		return local;
	},

	/**
	 * Replace the current shard's data with the new value.
	 * @param value New contents of the current shard's data.
	 * @public
	 * @see https://docs.screeps.com/api/#InterShardMemory.setLocal
	 */
	setLocal(value: string) {
		if (typeof value !== 'string') {
			throw new TypeError('Inter-shard memory value must be a string');
		} else if (value.length > INTER_SHARD_MEMORY_SIZE_LIMIT) {
			throw new Error('Inter-shard memory length exceeded 100 KB limit');
		}
		local = value;
		dirty = true;
	},

	/**
	 * Returns the string contents of another shard's data, as it was at the beginning of this tick.
	 * @param shard Shard name.
	 * @public
	 * @see https://docs.screeps.com/api/#InterShardMemory.getRemote
	 */
	getRemote(shard: string) {
		if (shard === shardName) {
			throw new Error(`"${shard}" is the current shard; use \`getLocal\` instead`);
		}
		return segments[shard] ?? null;
	},
};
