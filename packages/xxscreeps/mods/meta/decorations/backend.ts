import type { DecorationDefinition, DecorationProp } from './catalog.js';
import type { SeasonDecoration } from './config.js';
import type { Placement, PlacementError, PropValue } from './placement.js';
import type { JSONSchemaType } from 'ajv';
import type { Database } from 'xxscreeps/engine/db/index.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import * as fs from 'node:fs/promises';
import { hooks, makeValidatedPayloadRoute, makeValidatedQueryRoute } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { acquireWith } from 'xxscreeps/utility/async.js';
import { disposableToEffect } from 'xxscreeps/utility/utility.js';
import { assetContentType, catalog } from './catalog.js';
import { activateBadge, activateCreep, activateInRoom, deactivate, getGlobalDecorationChannel, getRoomDecorationChannel, listForRoom, listForUser, listGlobal, ownedDefinition } from './model.js';
import { conflicts, isOnWorldMap, isPlacedInRoom } from './placement.js';
import { enumeratedProps } from './renderer.js';

// `_id` is the official client's spelling, a Mongo-ism of the original server. It is wire shape and
// nothing else, so it lives in this file alone: stripped from what the client sends, put back on
// what it is served.

/**
 * A definition as the client wants it: the layout constraints sit inside `props`, next to the
 * property descriptors. They are kept apart internally because they are scalars, not descriptors.
 */
function toClientDefinition(definition: DecorationDefinition) {
	const { id, layout, props, ...rest } = definition;
	return { _id: id, ...rest, props: { ...layout, ...props } };
}

/**
 * The flat shape the client exchanges — the item id and the target sit alongside the property
 * values rather than beside them, which is the same shape the activate route reads back. A pack
 * property named `_id`, `shard` or `room` loses to them here; storage keeps them apart, so nothing
 * is actually dropped.
 *
 * `_id` has to travel *inside* this bag, not next to it: the room view flattens a placement into
 * one object and later matches socket updates against it by `_id`. Without one every update appends
 * the decoration again instead of recognising the copy it already has.
 */
export const placementToWire = (id: string, placement: Placement): Record<string, PropValue> => ({
	...placement.props,
	...placement.shard !== undefined && { shard: placement.shard },
	...placement.room !== undefined && { room: placement.room },
	_id: id,
});

hooks.register('route', {
	path: '/api/user/decorations/inventory',

	async execute(context) {
		const { userId } = context.state;
		if (userId === undefined) {
			return { ok: 1, list: [] };
		}
		const items = await listForUser(context.db, userId);
		return {
			ok: 1,
			list: items.map(item => ({
				_id: item.id,
				createdAt: new Date(item.createdAt).toISOString(),
				activatedAt: item.activatedAt === undefined ? undefined : new Date(item.activatedAt).toISOString(),
				// `null` is how the client spells "owned, not placed".
				active: item.active === undefined ? null : placementToWire(item.id, item.active),
				decoration: toClientDefinition(item.definition),
			})),
		};
	},
});

hooks.register('route', {
	path: '/api/user/decorations/themes',

	execute() {
		return { ok: 1, list: catalog.themes.map(({ id, ...rest }) => ({ _id: id, ...rest })) };
	},
});

interface ActivateRequest {
	_id: string;
	active: Record<string, unknown>;
}

const activateSchema: JSONSchemaType<ActivateRequest> = {
	type: 'object',
	properties: {
		_id: { type: 'string', minLength: 1 },
		// The property values are checked against the decoration's own schema, which ajv can't know.
		active: { type: 'object', required: [] },
	},
	required: [ '_id', 'active' ],
};

/** An accepted property value. */
interface ParsedProp {
	value: PropValue;
}

/** Longest free-form string a property may hold; lists arrive `!SEP!`-joined into one of these. */
const maxStringLength = 1024;

const isColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

/**
 * One property value as the client sent it. Numbers and booleans are accepted in their string
 * spelling too — the client round-trips placed values through form state and sends back whatever
 * that left behind.
 */
function parseProp(name: string, prop: DecorationProp, value: unknown): ParsedProp | PlacementError {
	switch (prop.type) {
		case 'boolean': {
			if (typeof value === 'boolean') {
				return { value };
			}
			return value === 'true' || value === '1' ? { value: true } :
				value === 'false' || value === '0' ? { value: false } :
				{ error: `'${name}' is not a boolean` };
		}

		case 'range': {
			// `Number` reads `null` and `[]` as zero, so anything but a number or its string
			// spelling is rejected before the conversion rather than after it.
			const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
			if (!Number.isFinite(number)) {
				return { error: `'${name}' is not a number` };
			} else if (prop.min !== undefined && number < prop.min) {
				return { error: `'${name}' is below its minimum of ${prop.min}` };
			} else if (prop.max !== undefined && number > prop.max) {
				return { error: `'${name}' is above its maximum of ${prop.max}` };
			}
			return { value: number };
		}

		case 'color':
			return typeof value === 'string' && isColor(value)
				? { value }
				: { error: `'${name}' is not a '#rrggbb' color` };

		case 'display':
		case 'string':
			return typeof value === 'string' && value.length <= maxStringLength
				? { value }
				: { error: `'${name}' is not a string of at most ${maxStringLength} characters` };
	}
}

/**
 * Property values checked against what the definition declares, whoever supplied them. Values left
 * out fall back to the definition's seed, so the result always carries a complete set and later
 * readers never have to consult the defaults again. Shared by the activation path, whose values
 * come from the client, and the season set, whose values come from the config — the definition is
 * the authority either way.
 */
function parseProps(definition: DecorationDefinition, values: Record<string, unknown>): Pick<Placement, 'props'> | PlacementError {
	const unclaimed = new Set(Object.keys(values));
	const props: Record<string, PropValue> = {};
	for (const [ name, prop ] of Object.entries(definition.props)) {
		const sent = unclaimed.delete(name);
		// The official client sends readonly properties along with everything else — its editor hides
		// them but its payload builder does not — so a value here is not an error. It does not win
		// either: readonly means the definition owns the value, and the seed fills it in, the same
		// way it covers a property the client left out.
		if (!sent || prop.readonly) {
			if (prop.default !== undefined) {
				props[name] = prop.default;
			}
			continue;
		}
		const parsed = parseProp(name, prop, values[name]);
		if ('error' in parsed) {
			return parsed;
		}
		// The renderer indexes a table by some of these, so they are closed sets rather than the free
		// strings the client's editor offers when a pack labels the property its own way.
		const allowed = Object.hasOwn(enumeratedProps, name) ? enumeratedProps[name] : undefined;
		if (allowed !== undefined && !allowed.includes(String(parsed.value))) {
			return { error: `'${name}' is not one of ${allowed.map(value => `'${value}'`).join(', ')}` };
		}
		props[name] = parsed.value;
	}
	const [ unknown ] = unclaimed;
	if (unknown !== undefined) {
		return { error: `'${definition.id}' has no property '${unknown}'` };
	}
	return { props };
}

/**
 * The `active` payload of an activation request, checked against what the definition declares.
 * Wire-only baggage — the `_id` the client sends back with an edited placement — is stripped
 * before the payload gets here.
 */
export function parsePlacement(definition: DecorationDefinition, active: Record<string, unknown>): Placement | PlacementError {
	const { shard, room, ...rest } = active;
	// The spread copied only the request's own keys, so what the definition's properties leave
	// unclaimed is exactly what the request named and the definition does not declare.
	const parsed = parseProps(definition, rest);
	if ('error' in parsed) {
		return parsed;
	}
	if (!isPlacedInRoom(definition.type)) {
		return parsed;
	} else if (typeof shard !== 'string' || typeof room !== 'string') {
		return { error: `'${definition.id}' must be placed in a room` };
	}
	return { shard, room, props: parsed.props };
}

/**
 * The activation request, parsed apart and dispatched to whichever kind of placement the definition
 * calls for. The three kinds share nothing past this point: a room placement has a target to check,
 * a creep decoration lands in the global index, a badge in no shared index at all.
 */
export async function activate(db: Database, shard: Shard, userId: string, itemId: string, active: Record<string, unknown>) {
	const definition = await ownedDefinition(db, userId, itemId);
	if (definition === undefined) {
		return { error: 'not owned' };
	}
	// `_id` comes back with an edited placement; it names the item the request already identifies,
	// so it is dropped here rather than checked against the pack's properties.
	const { _id, ...rest } = active;
	const placement = parsePlacement(definition, rest);
	if ('error' in placement) {
		return placement;
	}
	if (isPlacedInRoom(definition.type)) {
		if (placement.shard !== shard.name) {
			return { error: 'unknown shard' };
		}
		return activateInRoom(db, shard, userId, itemId, definition, placement.room!, placement.props);
	} else if (definition.type === 'creep') {
		return activateCreep(db, userId, itemId, definition, placement.props);
	} else {
		return activateBadge(db, userId, itemId, placement.props);
	}
}

hooks.register('route', {
	path: '/api/user/decorations/activate',
	method: 'post',

	execute: makeValidatedPayloadRoute(activateSchema, async context => {
		const { userId } = context.state;
		if (userId === undefined) {
			return { error: 'not authenticated' };
		}
		const { _id, active } = context.request.body;
		return await activate(context.db, context.shard, userId, _id, active) ?? { ok: 1 };
	}),
});

interface DeactivateRequest {
	decorations: string[];
}

/** Well past what the client sends at once, and low enough that one request stays one batch of reads. */
const maxDeactivateCount = 256;

const deactivateSchema: JSONSchemaType<DeactivateRequest> = {
	type: 'object',
	properties: {
		decorations: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: maxDeactivateCount },
	},
	required: [ 'decorations' ],
};

hooks.register('route', {
	path: '/api/user/decorations/deactivate',
	method: 'post',

	execute: makeValidatedPayloadRoute(deactivateSchema, async context => {
		const { userId } = context.state;
		if (userId === undefined) {
			return { error: 'not authenticated' };
		}
		await deactivate(context.db, userId, context.request.body.decorations);
		return { ok: 1 };
	}),
});

// Pack assets: files a pack ships, plus the previews the catalog drew for its landscapes. Only what
// the catalog registered is servable — the request never names a path on disk, it names a key in
// that map, so there is nothing to sanitize.
interface CachedAsset {
	body: Buffer;
	type: string;
}
const assetCache = new Map<string, CachedAsset>();

hooks.register('route', {
	path: '/assets/decorations/:asset(.*)',

	async execute(context) {
		const key = context.params.asset!;
		const asset = assetCache.get(key) ?? await async function() {
			const source = catalog.assets.get(key);
			if (source === undefined) {
				return;
			}
			const body = source.kind === 'file' ? await fs.readFile(source.file) : Buffer.from(source.body);
			const entry = {
				body,
				type: assetContentType(key) ?? function(): never {
					throw new Error(`Decoration asset '${key}' has an unsupported file type`);
				}(),
			};
			assetCache.set(key, entry);
			return entry;
		}();
		if (asset === undefined) {
			return;
		}
		// The url carries a version, so the response never needs revalidating: a changed asset shows
		// up under a new url instead.
		context.set('Cache-Control', 'public, max-age=31536000, immutable');
		context.set('Content-Type', asset.type);
		// These end up as WebGL textures, and the browser refuses to upload a cross-origin image it
		// was not allowed to read — pixi asks for one anonymously as soon as the url is not the
		// client's own origin, which is exactly what `assetBaseUrl` is for. Public files, no
		// credentials, nothing to scope the permission to.
		context.set('Access-Control-Allow-Origin', '*');
		context.body = asset.body;
		return true;
	},
});

/** What one wire item is made of; placements carry an owner, season items carry none. */
interface ClientItemSource {
	id: string;
	userId?: string;
	definition: DecorationDefinition;
	active: Placement;
}

/**
 * An item as the room and map views report it: the placement plus who owns it. A season item,
 * which nobody owns, carries no `user` at all — only the client's creep and object processors read
 * the field, and neither type can be a season item.
 */
const toClientItem = (item: ClientItemSource) => ({
	_id: item.id,
	...item.userId !== undefined && { user: item.userId },
	active: placementToWire(item.id, item.active),
	decoration: toClientDefinition(item.definition),
});

/**
 * Season decorations: a server-wide default set every room reports, the way the official season
 * servers dress the whole world. They are config rather than placements — no owner, no store, no
 * channel, never on the world map — resolved against the catalog once at startup, fatally on
 * anything wrong, for the same reason a broken pack is fatal: the alternative is serving rooms the
 * client cannot render.
 */
export function resolveSeasonDecorations(definitions: ReadonlyMap<string, DecorationDefinition>, entries: readonly SeasonDecoration[]) {
	const resolved = entries.map(({ id, props }) => {
		const definition = definitions.get(id);
		if (definition === undefined) {
			throw new Error(`Season decoration '${id}' is not in the catalog`);
		}
		// `creep` and `badge` stand in no room. `object` does, and having no owner is what makes it
		// work here: the client's object processor only compares owners when the item carries one, so
		// an ownerless overlay is drawn on every object of that kind rather than on nobody's.
		if (!isPlacedInRoom(definition.type)) {
			throw new Error(`Season decoration '${id}' is of type '${definition.type}', which cannot dress a room`);
		}
		const parsed = parseProps(definition, props ?? {});
		if ('error' in parsed) {
			throw new Error(`Season decoration '${id}': ${parsed.error}`);
		}
		return { definition, props: parsed.props };
	});
	resolved.forEach((item, index) => {
		const before = resolved.slice(0, index);
		if (before.some(earlier => earlier.definition === item.definition)) {
			throw new Error(`Season decoration '${item.definition.id}' is named twice`);
		}
		// The set stands in every room at once, so entries that could not share one room are refused
		// outright — the same conflict rules a player's placements are held to.
		const conflicting = before.find(earlier => conflicts(earlier.definition, item.definition));
		if (conflicting !== undefined) {
			throw new Error(`Season decorations '${conflicting.definition.id}' and '${item.definition.id}' conflict`);
		}
	});
	return resolved.map(item => toClientItem({
		id: `season/${item.definition.id}`,
		definition: item.definition,
		active: { props: item.props },
	}));
}

/** The season set, resolved once — a broken entry fails the server at startup. */
const seasonItems = resolveSeasonDecorations(catalog.definitions, config.decorations?.season ?? []);

/** Everything one room shows: player placements, the creep decorations, then the season set. */
export async function listRoomClientItems(db: Database, shardName: string, room: string, season = seasonItems) {
	const [ placed, global ] = await Promise.all([
		listForRoom(db, shardName, room),
		listGlobal(db),
	]);
	// The season set rides last: the client picks its wall and floor landscape with a first-match
	// `find` over this array, so whatever a player placed in the room wins over the server-wide
	// default — season items are default values, not overrides.
	return [ ...[ ...placed, ...global ].map(toClientItem), ...season ];
}

interface RoomDecorationsRequest {
	room: string;
	shard?: string;
}

const roomDecorationsSchema: JSONSchemaType<RoomDecorationsRequest> = {
	type: 'object',
	properties: {
		room: { type: 'string', minLength: 1 },
		shard: { type: 'string', nullable: true },
	},
	required: [ 'room' ],
};

hooks.register('route', {
	path: '/api/game/room-decorations',

	execute: makeValidatedQueryRoute(roomDecorationsSchema, async context => {
		const { room, shard } = context.request.query;
		return { ok: 1, decorations: await listRoomClientItems(context.db, shard ?? context.shard.name, room) };
	}),
});

hooks.register('roomSocket', async (shard, userId, roomName) => {
	// Re-read only once something in the room changed. Creep decorations show up in every room, so
	// this watches their channel too.
	let stale = true;
	const markStale = () => { stale = true; };
	using disposable = new DisposableStack();
	await acquireWith(
		fn => disposable.defer(fn),
		getRoomDecorationChannel(shard.db, shard.name, roomName).listen(markStale),
		getGlobalDecorationChannel(shard.db).listen(markStale),
	);

	return [
		disposableToEffect(disposable.move()),
		async () => {
			if (!stale) {
				return {};
			}
			stale = false;
			return { decorations: await listRoomClientItems(shard.db, shard.name, roomName) };
		},
	];
});

/** Whether any loaded decoration can stand in a room at all. A badge-only catalog leaves the map
 * with nothing to show, so the hook below is skipped outright. */
const hasRoomDecorations = Fn.some(catalog.definitions.values(), definition => isPlacedInRoom(definition.type));

// Creep decorations are deliberately absent: they belong to a creep rather than to a room, so there
// is no room for the map to draw them in. The season set is absent too — the whole point of a
// season is dressing every room without repainting the map.
if (hasRoomDecorations) {
	hooks.register('mapStats', async (context, { rooms, response, userIds }) => {
		const decorations: Record<string, unknown> = {};
		await Fn.mapAwait(rooms, async ({ room, stats }) => {
			const items = await listForRoom(context.db, context.shard.name, room.name);
			// The map only shows what its owner published to it.
			const visible = items.filter(item => isOnWorldMap(item.active));
			if (visible.length === 0) {
				return;
			}
			stats.decorations = visible.map(item => {
				userIds.add(item.userId);
				// The client looks the definition up in the dictionary below rather than inline, so the
				// same decoration placed in fifty rooms is described once.
				decorations[item.definition.id] = mapDecoration(item.definition);
				return { _id: item.id, user: item.userId, decoration: item.definition.id, active: placementToWire(item.id, item.active) };
			});
		});
		if (Object.keys(decorations).length > 0) {
			response.decorations = decorations;
		}
	});
}

/** The reduced shape the map renderer needs; it never draws the editable properties. */
const mapDecoration = (definition: DecorationDefinition) => ({
	type: definition.type,
	...definition.graphics !== undefined && { graphics: definition.graphics },
	...definition.tiling !== undefined && { tiling: definition.tiling },
	...definition.foregroundUrl !== undefined && { foregroundUrl: definition.foregroundUrl },
	...definition.floorForegroundUrl !== undefined && { floorForegroundUrl: definition.floorForegroundUrl },
});

// The client gates its inventory section on this flag, and builds the section's route and sidebar
// entry from the menu payload riding along with it.
hooks.register('version', serverData => {
	serverData.features.push({
		name: 'inventory',
		version: 1,
		menuData: [ {
			section: 0,
			after: 'World',
			item: { id: 'menu-item-inventory', label: 'Inventory', routerLink: '/inventory', svg: 'inventory' },
			module: 'InventoryModule',
		} ],
	});
});
