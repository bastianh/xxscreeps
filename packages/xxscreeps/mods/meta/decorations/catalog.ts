import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { config } from 'xxscreeps/config/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';

// The catalog is the set of decorations this server offers. It is static data, not user data:
// definitions are authored in *decoration packs* and loaded once at startup. A pack is a
// `pack.json` plus, optionally, the image files it references — see `pack/pack.json` for the
// bundled one.
//
// Anything wrong with a pack (unknown type, missing asset, dangling theme or prop reference,
// duplicate id) throws while loading. A server that boots with a broken catalog would hand the
// client definitions it can't render, so this is deliberately fatal.

/** Decoration types the client renders. `landscape` acts as both a floor and a wall landscape. */
export type DecorationType = 'floorLandscape' | 'wallLandscape' | 'landscape' | 'wallGraffiti' | 'creep' | 'object';

export interface DecorationTheme {
	_id: string;
	name: string;
	color?: string;
	/** Hidden themes are not offered in the client's theme filter. */
	hidden?: boolean;
}

/**
 * Schema of one editable property. `default` seeds the value when the decoration is placed;
 * `readonly` properties are part of the placed state but are not offered in the editor.
 */
export interface DecorationProp {
	type: 'boolean' | 'color' | 'display' | 'range' | 'string';
	label?: string;
	readonly?: boolean;
	default?: boolean | number | string;
	/** `range` only. */
	min?: number;
	max?: number;
	step?: number;
}

/**
 * Constraints on the placement rectangle. Kept apart from `props` here because they are scalars,
 * not property descriptors; the two are merged again when a definition is sent to the client,
 * which expects both in one bag.
 */
export interface DecorationLayout {
	/** Keep the aspect ratio while resizing. */
	proportional?: boolean;
	minWidth?: number;
	maxWidth?: number;
	minHeight?: number;
	maxHeight?: number;
}

/**
 * One image of a decoration. `color`, `alpha` and `visible` hold the *name* of a property, not a
 * value — the placed state supplies the value, which is how one graphic serves every colour a
 * player picks.
 */
export interface DecorationGraphic {
	url: string;
	color?: string;
	alpha?: string;
	visible?: string;
}

export interface DecorationPreview {
	original?: string;
	'128x128'?: string;
	'256x256'?: string;
}

export interface DecorationDefinition {
	_id: string;
	type: DecorationType;
	name: string;
	theme: string;
	/** 1–5. Drives the colour of the client's rarity indicator. */
	rarity?: number;
	groupDescription?: string;
	props: Record<string, DecorationProp>;
	layout?: DecorationLayout;
	graphics?: DecorationGraphic[];
	preview?: DecorationPreview;
	/** Wall overlay texture, `wallLandscape` / `landscape` only. */
	foregroundUrl?: string;
	/** Floor overlay texture, `floorLandscape` / `landscape` only. */
	floorForegroundUrl?: string;
	/** Repeat the graphics as a tile instead of stretching them. */
	tiling?: boolean;
	tileScale?: number;
	/** Target object type, `object` only. */
	objectType?: string;
}

export interface DecorationPack {
	/** Slug identifying the pack; appears in the public url of its assets. */
	name: string;
	themes: DecorationTheme[];
	decorations: DecorationDefinition[];
}

export interface Catalog {
	definitions: ReadonlyMap<string, DecorationDefinition>;
	themes: readonly DecorationTheme[];
	/** Files referenced by the loaded packs, keyed by their `<pack>/<file>` public path. */
	assets: ReadonlyMap<string, URL>;
}

const propSchema = {
	type: 'object',
	properties: {
		type: { enum: [ 'boolean', 'color', 'display', 'range', 'string' ] },
		label: { type: 'string' },
		readonly: { type: 'boolean' },
		default: { type: [ 'boolean', 'number', 'string' ] },
		min: { type: 'number' },
		max: { type: 'number' },
		step: { type: 'number' },
	},
	required: [ 'type' ],
	additionalProperties: false,
};

const packSchema = {
	type: 'object',
	properties: {
		name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
		themes: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					_id: { type: 'string', minLength: 1 },
					name: { type: 'string', minLength: 1 },
					color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
					hidden: { type: 'boolean' },
				},
				required: [ '_id', 'name' ],
				additionalProperties: false,
			},
		},
		decorations: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					_id: { type: 'string', minLength: 1 },
					type: { enum: [ 'floorLandscape', 'wallLandscape', 'landscape', 'wallGraffiti', 'creep', 'object' ] },
					name: { type: 'string', minLength: 1 },
					theme: { type: 'string', minLength: 1 },
					rarity: { type: 'integer', minimum: 1, maximum: 5 },
					groupDescription: { type: 'string' },
					props: { type: 'object', additionalProperties: propSchema },
					layout: {
						type: 'object',
						properties: {
							proportional: { type: 'boolean' },
							minWidth: { type: 'number' },
							maxWidth: { type: 'number' },
							minHeight: { type: 'number' },
							maxHeight: { type: 'number' },
						},
						additionalProperties: false,
					},
					graphics: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								url: { type: 'string', minLength: 1 },
								color: { type: 'string' },
								alpha: { type: 'string' },
								visible: { type: 'string' },
							},
							required: [ 'url' ],
							additionalProperties: false,
						},
					},
					preview: {
						type: 'object',
						properties: {
							original: { type: 'string' },
							'128x128': { type: 'string' },
							'256x256': { type: 'string' },
						},
						additionalProperties: false,
					},
					foregroundUrl: { type: 'string' },
					floorForegroundUrl: { type: 'string' },
					tiling: { type: 'boolean' },
					tileScale: { type: 'number' },
					objectType: { type: 'string' },
				},
				required: [ '_id', 'type', 'name', 'theme', 'props' ],
				additionalProperties: false,
			},
		},
	},
	required: [ 'name', 'themes', 'decorations' ],
	additionalProperties: false,
};

// `allowUnionTypes` for the property defaults, which are whatever the property's own type says.
const ajv = new Ajv({ allowUnionTypes: true });
const validatePack = ajv.compile<DecorationPack>(packSchema);

const contentTypes: Record<string, string> = {
	'.gif': 'image/gif',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
};

/** Content type of a pack asset, or `undefined` for file types packs may not reference. */
export function assetContentType(file: string) {
	return contentTypes[path.extname(file).toLowerCase()];
}

/** Public url prefix of pack assets. Relative by default; absolute when a base url is configured. */
const assetUrlPrefix = `${config.decorations.assetBaseUrl ?? ''}/assets/decorations`;

/** Urls a pack may reference without shipping the file: other origins, and data urls. */
const isExternalUrl = (value: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(value);

async function loadPack(url: URL) {
	const raw: unknown = JSON.parse(await fs.readFile(url, 'utf8'));
	if (!validatePack(raw)) {
		throw new Error(`Invalid decoration pack '${url.pathname}': ${ajv.errorsText(validatePack.errors)}`);
	}
	const pack = raw;
	const directory = new URL('.', url);
	const assets = new Map<string, URL>();

	// Relative references name a file inside the pack; they are checked here and rewritten to the
	// url the asset route serves them from.
	const resolveAsset = async (value: string) => {
		if (isExternalUrl(value)) {
			return value;
		}
		const file = new URL(value, directory);
		if (!file.href.startsWith(directory.href)) {
			throw new Error(`Asset '${value}' of decoration pack '${pack.name}' escapes the pack directory`);
		}
		if (assetContentType(file.pathname) === undefined) {
			throw new Error(`Asset '${value}' of decoration pack '${pack.name}' has an unsupported file type`);
		}
		try {
			await fs.stat(file);
		} catch (cause) {
			throw new Error(`Asset '${value}' of decoration pack '${pack.name}' does not exist`, { cause });
		}
		const key = `${pack.name}/${decodeURIComponent(file.href.slice(directory.href.length))}`;
		assets.set(key, file);
		return `${assetUrlPrefix}/${key}`;
	};

	const resolvePreview = async (preview: DecorationPreview): Promise<DecorationPreview> => ({
		...preview.original !== undefined && { original: await resolveAsset(preview.original) },
		...preview['128x128'] !== undefined && { '128x128': await resolveAsset(preview['128x128']) },
		...preview['256x256'] !== undefined && { '256x256': await resolveAsset(preview['256x256']) },
	});

	const definitions = await Fn.mapAwait(pack.decorations, async (definition): Promise<DecorationDefinition> => {
		for (const graphic of definition.graphics ?? []) {
			for (const reference of [ graphic.color, graphic.alpha, graphic.visible ]) {
				if (reference !== undefined && definition.props[reference] === undefined) {
					throw new Error(`Decoration '${definition._id}' has a graphic referencing unknown property '${reference}'`);
				}
			}
		}
		if (definition.type === 'object' && definition.objectType === undefined) {
			throw new Error(`Decoration '${definition._id}' is an object overlay but names no 'objectType'`);
		}
		return {
			...definition,
			...definition.foregroundUrl !== undefined && { foregroundUrl: await resolveAsset(definition.foregroundUrl) },
			...definition.floorForegroundUrl !== undefined && { floorForegroundUrl: await resolveAsset(definition.floorForegroundUrl) },
			...definition.preview !== undefined && { preview: await resolvePreview(definition.preview) },
			...definition.graphics !== undefined && {
				graphics: await Fn.mapAwait(definition.graphics, async graphic => ({ ...graphic, url: await resolveAsset(graphic.url) })),
			},
		};
	});

	return { name: pack.name, themes: pack.themes, definitions, assets };
}

export async function loadCatalog(urls: Iterable<URL>): Promise<Catalog> {
	const definitions = new Map<string, DecorationDefinition>();
	const themes = new Map<string, DecorationTheme>();
	const assets = new Map<string, URL>();
	const packNames = new Set<string>();

	for (const url of urls) {
		const pack = await loadPack(url);
		if (packNames.has(pack.name)) {
			throw new Error(`Duplicate decoration pack name '${pack.name}'`);
		}
		packNames.add(pack.name);
		for (const theme of pack.themes) {
			if (themes.has(theme._id)) {
				throw new Error(`Duplicate decoration theme '${theme._id}'`);
			}
			themes.set(theme._id, theme);
		}
		for (const definition of pack.definitions) {
			if (definitions.has(definition._id)) {
				throw new Error(`Duplicate decoration '${definition._id}'`);
			}
			definitions.set(definition._id, definition);
		}
		for (const [ key, file ] of pack.assets) {
			assets.set(key, file);
		}
	}

	// Themes may live in a different pack than the decorations using them, so this is checked once
	// everything is loaded.
	for (const definition of definitions.values()) {
		if (!themes.has(definition.theme)) {
			throw new Error(`Decoration '${definition._id}' belongs to unknown theme '${definition.theme}'`);
		}
	}

	return { definitions, themes: [ ...themes.values() ], assets };
}

/** A pack path from the config may point at a `pack.json` or at the directory holding one. */
async function resolvePackPath(value: string) {
	const url = pathToFileURL(path.resolve(value));
	const stat = await async function() {
		try {
			return await fs.stat(url);
		} catch (cause) {
			throw new Error(`Decoration pack '${value}' does not exist`, { cause });
		}
	}();
	return stat.isDirectory() ? new URL('pack.json', `${url.href}/`) : url;
}

const packUrls = [
	...config.decorations.builtin ? [ new URL('pack/pack.json', import.meta.url) ] : [],
	...await Fn.mapAwait(config.decorations.packs ?? [], resolvePackPath),
];

/** The catalog this server serves, loaded from the configured packs. */
export const catalog = await loadCatalog(packUrls);
