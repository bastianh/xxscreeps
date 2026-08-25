import type { ShardTransfer } from './model.js';
import { registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { consumeObjectsForShard } from './model.js';

// Objects sent here by another shard's portals. This runs in `main`, which holds the game mutex and
// owns this shard's clock, so it is the one place that can safely decide which tick an arrival
// belongs to. Draining pops one entry at a time, so a portal firing on the other shard mid-drain
// keeps its object rather than losing it.
registerShardTickProcessor(async (shard, time) => {
	for await (const json of consumeObjectsForShard(shard.db, shard.name)) {
		const transfer = JSON.parse(json) as ShardTransfer;
		await pushIntentsForRoomNextTick(shard, transfer.room, transfer.userId, {
			internal: true,
			local: { importFromShard: [ [ transfer.payload, time + 1 - transfer.time, transfer.userId ] ] },
		});
	}
});
