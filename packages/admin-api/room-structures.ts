import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import * as C from 'xxscreeps/game/constants/index.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { parseRoomName } from 'xxscreeps/game/room/name.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { registerAdminRoute } from './routes.js';
import { resolveUserId } from './users.js';
import { checkCreateAdminStructure, isAdminStructureType, type AdminStructureType } from './structures.js';

type CreateStructureRequest = {
	x: unknown;
	y: unknown;
	structureType: unknown;
	owner?: unknown;
};

const roomNamePattern = /^[WE]\d+[NS]\d+$/i;

function normalizeRoomName(roomName: string) {
	if (!roomNamePattern.test(roomName)) {
		return;
	}
	const room = parseRoomName(roomName);
	if (
		!Number.isInteger(room.rx) || !Number.isInteger(room.ry) ||
		room.rx < 0 || room.rx > 255 || room.ry < 0 || room.ry > 255
	) {
		return;
	}
	return roomName.toUpperCase();
}

function normalizeCoordinate(value: unknown) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 && number < 50 ? number : undefined;
}

function describeResult(code: number) {
	switch (code) {
		case C.ERR_INVALID_ARGS: return 'invalid request';
		case C.ERR_INVALID_TARGET: return 'invalid placement';
		case C.ERR_NOT_OWNER: return 'owner mismatch';
		case C.ERR_RCL_NOT_ENOUGH: return 'rcl not enough';
		default: return 'invalid placement';
	}
}

export async function createRoomStructure(db: Database, shard: Shard, roomName: string, body: unknown) {
	const room = normalizeRoomName(roomName);
	if (room === undefined) {
		return { error: 'invalid room' };
	}
	if (typeof body !== 'object' || body === null) {
		return { error: 'invalid request' };
	}
	const { x, y, structureType, owner } = body as CreateStructureRequest;
	const xx = normalizeCoordinate(x);
	const yy = normalizeCoordinate(y);
	if (xx === undefined || yy === undefined || typeof structureType !== 'string' || !isAdminStructureType(structureType)) {
		return { error: 'invalid request' };
	}

	const normalizedOwner = owner === undefined || owner === null
		? undefined
		: typeof owner === 'string'
			? await resolveUserId(db, owner)
			: null;
	if (normalizedOwner === null) {
		return { error: 'invalid owner' };
	}

	let loadedRoom;
	try {
		loadedRoom = await shard.loadRoom(room);
	} catch {
		return { error: 'not found' };
	}
	const pos = new RoomPosition(xx, yy, room);
	const actor = normalizedOwner ?? loadedRoom['#user'] ?? loadedRoom.controller?.['#user'] ?? '1';
	const world = await shard.loadWorld();
	const result = runOneShot(world, loadedRoom, shard.time, actor, () =>
		checkCreateAdminStructure(loadedRoom, pos, structureType as AdminStructureType, normalizedOwner));
	if (result !== C.OK) {
		return { error: describeResult(result), code: result };
	}

	await pushIntentsForRoomNextTick(shard, room, actor, {
		local: { adminCreateStructure: [ [ structureType, xx, yy, normalizedOwner ?? null ] ] },
		internal: true,
	});
	return {
		ok: 1,
		scheduledTick: shard.time + 1,
		structure: {
			room,
			x: xx,
			y: yy,
			structureType,
			owner: normalizedOwner ?? null,
		},
	};
}

registerAdminRoute({
	method: 'post',
	path: '/rooms/:room/structures',
	execute: context => createRoomStructure(context.db, context.shard, context.params.room ?? '', context.request.body),
});
