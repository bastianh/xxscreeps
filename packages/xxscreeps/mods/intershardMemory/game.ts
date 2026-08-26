import { hooks, registerGlobal } from 'xxscreeps/game/index.js';
import { InterShardMemory, flush, initialize, load } from './memory.js';

declare module 'xxscreeps/game/runtime.js' {
	interface Global {
		/**
		 * `InterShardMemory` object provides an interface for communicating between shards. Your
		 * script is executed separately on each shard, and their `Memory` objects are isolated from
		 * each other. In order to pass messages and data between shards, you need to use
		 * `InterShardMemory` instead.
		 * @public
		 * @see https://docs.screeps.com/api/#InterShardMemory
		 */
		InterShardMemory: typeof InterShardMemory;
	}
}
registerGlobal('InterShardMemory', InterShardMemory);

hooks.register('runtimeConnector', {
	initialize(payload) {
		initialize(payload.shardName);
	},

	receive(payload) {
		load(payload.interShardMemory);
	},

	send(result) {
		result.interShardMemoryUpdate = flush();
	},
});
