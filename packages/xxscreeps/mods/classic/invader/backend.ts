import type { JSONSchemaType } from 'ajv';
import { ClientError, hooks, makeValidatedPayloadRoute, requireUserId } from 'xxscreeps/backend/index.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import * as C from 'xxscreeps:mods/constants';
import { kInvaderUserId } from './game.js';

interface CreateInvaderRequest {
	room: string;
	x: number;
	y: number;
	size: string;
	type: string;
}

const createInvaderRequestSchema: JSONSchemaType<CreateInvaderRequest> = {
	type: 'object',
	properties: {
		room: { type: 'string' },
		x: { type: 'number' },
		y: { type: 'number' },
		size: { type: 'string' },
		type: { type: 'string' },
	},
	required: [ 'room', 'x', 'y', 'size', 'type' ],
};

hooks.register('route', {
	path: '/api/game/create-invader',
	method: 'post',

	execute: makeValidatedPayloadRoute(createInvaderRequestSchema, async context => {
		const userId = requireUserId(context);
		const { room: roomName, x, y, size, type: rawType } = context.request.body;
		const type = rawType.toLowerCase();

		// Sanity check
		const pos = new RoomPosition(x, y, roomName);
		if (
			(size !== 'big' && size !== 'small') ||
			![ 'healer', 'melee', 'ranged' ].includes(type)
		) {
			return;
		}

		// Room state check
		const room = await context.shard.loadRoom(pos.roomName);
		if (room['#user'] !== userId) {
			throw new ClientError('Not room owner');
		}
		const creeps = room.find(C.FIND_CREEPS);
		if (creeps.filter(creep => creep['#user'] === kInvaderUserId).length >= 5) {
			throw new ClientError('Too many invaders');
		} else if (creeps.some(creep => creep['#user'] !== userId && creep['#user'] !== kInvaderUserId)) {
			throw new ClientError('Hostile creeps exist');
		}

		// Send the intent off to the processor
		await pushIntentsForRoomNextTick(context.shard, pos.roomName, userId, {
			local: { requestInvader: [ [ pos.x, pos.y, type, size ] ] },
			internal: true,
		});

		return { ok: 1 };
	}),
});
