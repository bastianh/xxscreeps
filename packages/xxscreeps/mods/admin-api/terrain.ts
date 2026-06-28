import type { Shard } from 'xxscreeps/engine/db/index.js';
import type { Terrain } from 'xxscreeps/game/terrain.js';
import { isGamePaused } from 'xxscreeps/engine/service/control.js';
import * as MapSchema from 'xxscreeps/game/map.js';
import { parseRoomName } from 'xxscreeps/game/room/name.js';
import { TerrainWriter, packExits } from 'xxscreeps/game/terrain.js';
import { makeReader, makeWriter } from 'xxscreeps/schema/index.js';
import { registerAdminRoute } from './routes.js';

type TerrainValue = 0 | 1 | 2;
type PatchTile = {
	x: unknown;
	y: unknown;
	terrain: unknown;
};

const readTerrain = makeReader(MapSchema.schema);
const writeTerrain = makeWriter(MapSchema.schema);
const terrainPattern = /^[012]{2500}$/;
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

function terrainToString(terrain: TerrainWriter) {
	let terrainString = '';
	for (let yy = 0; yy < 50; ++yy) {
		for (let xx = 0; xx < 50; ++xx) {
			terrainString += terrain.get(xx, yy);
		}
	}
	return terrainString;
}

function parseTerrainValue(value: unknown): TerrainValue | undefined {
	switch (value) {
		case 0:
		case '0':
		case 'plain': return 0;
		case 1:
		case '1':
		case 'wall': return 1;
		case 2:
		case '2':
		case 'swamp': return 2;
		default: return;
	}
}

function copyTerrain(source: Terrain) {
	const buffer = new Uint8Array(625);
	source.getRawBuffer(buffer, 'xxscreeps');
	return new TerrainWriter(buffer);
}

async function loadTerrainMap(shard: Shard) {
	return readTerrain(await shard.data.req('terrain', { blob: true }));
}

export async function getTerrain(shard: Shard, roomName: string) {
	const room = normalizeRoomName(roomName);
	if (room === undefined) {
		return { error: 'invalid room' };
	}
	const terrainMap = await loadTerrainMap(shard);
	const info = terrainMap.get(room);
	if (info === undefined) {
		return { error: 'not found' };
	}
	return {
		ok: 1,
		room,
		terrain: terrainToString(copyTerrain(info.terrain)),
	};
}

async function saveRoomTerrain(shard: Shard, room: string, terrain: TerrainWriter) {
	const terrainMap = await loadTerrainMap(shard);
	const info = terrainMap.get(room);
	if (info === undefined) {
		return { error: 'not found' };
	}
	terrainMap.set(room, {
		...info,
		exits: packExits(terrain),
		terrain,
	});
	await shard.data.set('terrain', writeTerrain(terrainMap));
	await shard.save();
	return { ok: 1, restartRequired: true };
}

async function requirePaused(shard: Shard) {
	if (!await isGamePaused(shard)) {
		return { error: 'game must be paused' };
	}
}

export async function putTerrain(shard: Shard, roomName: string, body: unknown) {
	const room = normalizeRoomName(roomName);
	if (room === undefined) {
		return { error: 'invalid room' };
	}
	if (typeof body !== 'object' || body === null || typeof (body as { terrain?: unknown }).terrain !== 'string') {
		return { error: 'invalid terrain' };
	}
	const terrainString = (body as { terrain: string }).terrain;
	if (!terrainPattern.test(terrainString)) {
		return { error: 'invalid terrain' };
	}
	const pausedError = await requirePaused(shard);
	if (pausedError) {
		return pausedError;
	}
	const terrain = new TerrainWriter();
	for (const [ index, value ] of [ ...terrainString ].entries()) {
		terrain.set(index % 50, Math.floor(index / 50), Number(value));
	}
	return saveRoomTerrain(shard, room, terrain);
}

export async function patchTerrain(shard: Shard, roomName: string, body: unknown) {
	const room = normalizeRoomName(roomName);
	if (room === undefined) {
		return { error: 'invalid room' };
	}
	if (typeof body !== 'object' || body === null || !Array.isArray((body as { tiles?: unknown }).tiles)) {
		return { error: 'invalid tiles' };
	}
	const tiles = (body as { tiles: PatchTile[] }).tiles;
	for (const tile of tiles) {
		const terrain = parseTerrainValue(tile.terrain);
		if (
			!Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
			(tile.x as number) < 0 || (tile.x as number) > 49 ||
			(tile.y as number) < 0 || (tile.y as number) > 49 ||
			terrain === undefined
		) {
			return { error: 'invalid tile' };
		}
	}
	const pausedError = await requirePaused(shard);
	if (pausedError) {
		return pausedError;
	}
	const terrainMap = await loadTerrainMap(shard);
	const info = terrainMap.get(room);
	if (info === undefined) {
		return { error: 'not found' };
	}
	const terrain = copyTerrain(info.terrain);
	for (const tile of tiles) {
		terrain.set(tile.x as number, tile.y as number, parseTerrainValue(tile.terrain)!);
	}
	return saveRoomTerrain(shard, room, terrain);
}

registerAdminRoute({
	path: '/terrain/:room',
	execute: context => getTerrain(context.shard, context.params.room ?? ''),
});

registerAdminRoute({
	method: 'put',
	path: '/terrain/:room',
	execute: context => putTerrain(context.shard, context.params.room ?? '', context.request.body),
});

registerAdminRoute({
	method: 'patch',
	path: '/terrain/:room',
	execute: context => patchTerrain(context.shard, context.params.room ?? '', context.request.body),
});
