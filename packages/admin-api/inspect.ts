import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import type { KeyValProvider } from 'xxscreeps/engine/db/storage/provider.js';
import { Buffer } from 'node:buffer';
import * as RoomSchema from 'xxscreeps/engine/db/room.js';
import * as CodeSchema from 'xxscreeps/engine/db/user/code-schema.js';
import * as MapSchema from 'xxscreeps/game/map.js';
import type { Terrain } from 'xxscreeps/game/terrain.js';
import { typedArrayToString } from 'xxscreeps/utility/string.js';
import { makeReader } from 'xxscreeps/schema/index.js';

const terrainReader = makeReader(MapSchema.schema);

export type StoreName = 'db' | 'database' | 'scratch' | 'shard';

export function selectStore(db: Database, shard: Shard, store: string): KeyValProvider | undefined {
	switch (store) {
		case 'db':
		case 'database': return db.data;
		case 'shard': return shard.data;
		case 'scratch': return shard.scratch;
		default: return;
	}
}

export function requiredString(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function queryNumber(value: unknown, fallback: number) {
	if (value === undefined) {
		return fallback;
	}
	const number = Number(value);
	return Number.isInteger(number) ? number : undefined;
}

function terrainToString(terrain: Terrain) {
	let terrainString = '';
	for (let yy = 0; yy < 50; ++yy) {
		for (let xx = 0; xx < 50; ++xx) {
			terrainString += terrain.get(xx, yy);
		}
	}
	return terrainString;
}

function encodeBlob(blob: Readonly<Uint8Array>) {
	return {
		encoding: 'base64',
		byteLength: blob.byteLength,
		base64: Buffer.from(blob).toString('base64'),
	};
}

function decodeMemoryBlob(blob: Readonly<Uint8Array>) {
	return typedArrayToString(new Uint16Array(blob.buffer, blob.byteOffset, blob.byteLength >>> 1));
}

function serializeCodeContent(content: Map<string, string | Uint8Array>) {
	return Object.fromEntries([ ...content.entries() ].map(([ name, value ]) => [
		name,
		typeof value === 'string'
			? { type: 'string', content: value }
			: { type: 'buffer', ...encodeBlob(value) },
	]));
}

function serializeRoomBlob(blob: Readonly<Uint8Array>) {
	const room = RoomSchema.read(RoomSchema.upgrade(blob));
	return {
		name: room.name,
		users: room['#users'],
		eventLogLength: room['#eventLog'].length,
		objects: room['#objects'].map(object => ({
			id: object.id,
			type: object.constructor.name,
			x: object.pos.x,
			y: object.pos.y,
			room: object.pos.roomName,
			...'#user' in object && { user: object['#user' as keyof typeof object] },
		})),
	};
}

export function decodeKnownBlob(key: string, blob: Readonly<Uint8Array>) {
	if (key === 'terrain') {
		const terrain = terrainReader(blob);
		return {
			type: 'terrain',
			rooms: [ ...terrain.entries() ].map(([ room, info ]) => ({
				room,
				exits: info.exits,
				terrain: terrainToString(info.terrain),
			})),
		};
	}
	if (/^room[01]\//.test(key)) {
		return {
			type: 'room',
			room: serializeRoomBlob(blob),
		};
	}
	if (/^user\/[^/]+\/(?:memory|segment\d+)$/.test(key)) {
		return {
			type: 'utf16',
			content: decodeMemoryBlob(blob),
		};
	}
	if (/^user\/[^/]+\/code\//.test(key)) {
		return {
			type: 'codeStrings',
			modules: Object.fromEntries(CodeSchema.readStrings(blob)),
		};
	}
	if (/^user\/[^/]+\/bins\//.test(key)) {
		return {
			type: 'codeBuffers',
			modules: serializeCodeContent(new Map(CodeSchema.readBuffers(blob))),
		};
	}
	return {
		type: 'blob',
		...encodeBlob(blob),
	};
}

export async function readBlob(store: KeyValProvider, key: string) {
	const blob = await store.get(key, { blob: true });
	if (blob === null) {
		return null;
	}
	return decodeKnownBlob(key, blob);
}

export { decodeMemoryBlob, encodeBlob, serializeCodeContent };
