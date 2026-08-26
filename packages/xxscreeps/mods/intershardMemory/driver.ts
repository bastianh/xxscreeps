import { hooks } from 'xxscreeps/engine/runner/symbols.js';
import { loadSegments, saveSegment } from './model.js';

declare module 'xxscreeps/engine/runner/index.js' {
	interface TickPayload {
		/** What every shard published, keyed by shard name */
		interShardMemory: Record<string, string | null>;
	}

	interface TickResult {
		/** A new value for this shard's entry, when the player wrote one */
		interShardMemoryUpdate?: string | undefined;
	}
}

hooks.register('runnerConnector', player => {
	const { shard, userId } = player;
	return [ () => {}, {
		async refresh(payload) {
			// Read every tick: another shard's runner may have written its entry since the last one,
			// and that is the whole point of the segment.
			payload.interShardMemory = await loadSegments(shard.db, userId);
		},

		async save(payload) {
			if (payload.interShardMemoryUpdate !== undefined) {
				await saveSegment(shard.db, userId, shard.name, payload.interShardMemoryUpdate);
			}
		},
	} ];
});
