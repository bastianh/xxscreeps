import type { DecorationDefinition } from './catalog.js';
import type { JSONSchemaType } from 'ajv';
import * as fs from 'node:fs/promises';
import makeEtag from 'etag';
import { hooks, makeValidatedPayloadRoute } from 'xxscreeps/backend/index.js';
import { assetContentType, catalog } from './catalog.js';
import { activate, deactivate, listForUser, ownedDefinition } from './model.js';
import { parsePlacement } from './placement.js';

/**
 * A definition as the client wants it: the layout constraints sit inside `props`, next to the
 * property descriptors. They are kept apart internally because they are scalars, not descriptors.
 */
function toClientDefinition(definition: DecorationDefinition) {
	const { layout, props, ...rest } = definition;
	return { ...rest, props: { ...layout, ...props } };
}

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
				...item.createdAt !== undefined && { createdAt: new Date(item.createdAt).toISOString() },
				...item.activatedAt !== undefined && { activatedAt: new Date(item.activatedAt).toISOString() },
				// `null` is how the client spells "owned, not placed".
				active: item.active ?? null,
				decoration: toClientDefinition(item.definition),
			})),
		};
	},
});

hooks.register('route', {
	path: '/api/user/decorations/themes',

	execute() {
		return { ok: 1, list: catalog.themes };
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

hooks.register('route', {
	path: '/api/user/decorations/activate',
	method: 'post',

	execute: makeValidatedPayloadRoute(activateSchema, async context => {
		const { userId } = context.state;
		if (userId === undefined) {
			return { error: 'not authenticated' };
		}
		const { _id, active } = context.request.body;
		const definition = await ownedDefinition(context.db, userId, _id);
		if (definition === undefined) {
			return { error: 'not owned' };
		}
		const placement = parsePlacement(definition, active);
		if ('error' in placement) {
			return placement;
		}
		return await activate(context.db, context.shard, userId, _id, placement) ?? { ok: 1 };
	}),
});

interface DeactivateRequest {
	decorations: string[];
}

const deactivateSchema: JSONSchemaType<DeactivateRequest> = {
	type: 'object',
	properties: {
		decorations: { type: 'array', items: { type: 'string', minLength: 1 } },
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
const assetCache = new Map<string, { body: Buffer; etag: string; type: string }>();

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
				etag: makeEtag(body),
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
		context.set('Cache-Control', 'public');
		context.set('ETag', asset.etag);
		context.set('Content-Type', asset.type);
		context.body = asset.body;
		return true;
	},
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
