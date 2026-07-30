import type { DecorationDefinition } from './catalog.js';
import * as fs from 'node:fs/promises';
import makeEtag from 'etag';
import { hooks } from 'xxscreeps/backend/index.js';
import { assetContentType, catalog } from './catalog.js';
import { listForUser } from './model.js';

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
				createdAt: new Date(item.createdAt).toISOString(),
				// Placing decorations arrives with activation; until then nothing is placed.
				active: null,
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

// Pack assets. Only files the catalog references are servable — the request never names a path on
// disk, it names a key in that map, so there is nothing to sanitize.
const assetCache = new Map<string, { body: Buffer; etag: string; type: string }>();

hooks.register('route', {
	path: '/assets/decorations/:asset(.*)',

	async execute(context) {
		const key = context.params.asset!;
		const asset = assetCache.get(key) ?? await async function() {
			const file = catalog.assets.get(key);
			if (file === undefined) {
				return;
			}
			const body = await fs.readFile(file);
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
