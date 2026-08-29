import type { JSONSchemaType } from 'ajv';
import { hooks, makeValidatedPayloadRoute } from 'xxscreeps/backend/index.js';
import { loadShardLimits, saveShardLimits } from 'xxscreeps/engine/runner/model.js';

hooks.register('route', {
	path: '/api/user/cpu-shards',

	async execute(context) {
		const { userId } = context.state;
		if (userId === undefined) {
			return { error: 'not logged in' };
		}
		return { ok: 1, shards: await loadShardLimits(context.db, userId) };
	},
});

interface CpuShardsRequest {
	cpu: Record<string, number>;
}

const cpuShardsRequestSchema: JSONSchemaType<CpuShardsRequest> = {
	type: 'object',
	properties: {
		cpu: {
			type: 'object',
			required: [],
			additionalProperties: { type: 'number' },
		},
	},
	required: [ 'cpu' ],
};

hooks.register('route', {
	path: '/api/user/cpu-shards',
	method: 'post',

	execute: makeValidatedPayloadRoute(cpuShardsRequestSchema, async context => {
		const { userId } = context.state;
		if (userId === undefined) {
			return { error: 'not logged in' };
		}
		// The split has to add up to the account's CPU and may be rate limited, so the model decides
		// rather than the route.
		const refusal = await saveShardLimits(context.db, userId, context.request.body.cpu);
		return refusal === null ? { ok: 1 } : { error: refusal };
	}),
});
