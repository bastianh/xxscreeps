import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import { tickSpeed } from 'xxscreeps/engine/service/tick.js';
import { Fn } from 'xxscreeps/functional/fn.js';

hooks.register('route', {
	path: '/api/game/shards/info',
	async execute(context) {
		return {
			ok: 1,
			shards: await Fn.mapAwait(context.backend.shards.values(), async ({ shard, accessibleRooms }) => ({
				name: shard.name,
				// A rolling history of tick durations, which the client draws as a sparkline. Nothing
				// records one yet, and an empty series renders as no sparkline at all.
				lastTicks: [],
				cpuLimit: config.runner.cpu.limit,
				rooms: accessibleRooms.size,
				// Users this shard is running code for
				users: await shard.scratch.sCard('activeUsers'),
				tick: tickSpeed,
			})),
		};
	},
});
