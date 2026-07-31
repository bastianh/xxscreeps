import type { DecorationPack, PackSource } from './catalog.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { insertControlledRoom } from 'xxscreeps/mods/classic/controller/model.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { catalog, loadCatalog } from './catalog.js';
import { activate, deactivate, grant, listForRoom, listForUser, revoke } from './model.js';
import { conflicts, isOnWorldMap, parsePlacement, placementToWire } from './placement.js';

const alice = '100';
const shard = 'shard0';
const roomName = 'W10N10';
const otherRoomName = 'W10N9';

/**
 * A floor landscape placement, built the way the activate route builds one — so the tests see the
 * defaults the definition seeds rather than an empty property bag.
 */
function floorPlacement(active: Record<string, unknown> = {}) {
	const placement = parsePlacement(catalog.definitions.get('xx-floor-plain')!, { shard, room: roomName, ...active });
	if ('error' in placement) {
		throw new Error(placement.error);
	}
	return placement;
}

/** Toggle implicit ownership for one test, restoring whatever the config said. */
function withGrantAll(grantAll: boolean) {
	const decorations = config.decorations ??= {};
	const previous = decorations.grantAll;
	decorations.grantAll = grantAll;
	return {
		[Symbol.dispose]() {
			if (previous === undefined) {
				delete decorations.grantAll;
			} else {
				decorations.grantAll = previous;
			}
		},
	};
}

/**
 * A pack the loader can read without touching the disk. Only packs referencing an asset that must
 * actually exist need a directory holding one — see {@link withAssetFile}.
 */
const source = (pack: DecorationPack, directory = new URL('in-memory/', import.meta.url)): PackSource =>
	({ directory, body: JSON.stringify(pack) });

/** A directory holding one file, for the single case where the loader stats a real asset. */
async function withAssetFile(name: string, content: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xxscreeps-pack-'));
	const file = path.join(directory, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
	return {
		url: pathToFileURL(`${directory}/`),
		async [Symbol.asyncDispose]() {
			await fs.rm(directory, { recursive: true });
		},
	};
}

const theme = { _id: 'test-theme', name: 'Test' };
const landscape = {
	_id: 'test-floor',
	type: 'floorLandscape' as const,
	name: 'Test Floor',
	theme: theme._id,
	props: { floorBackgroundColor: { type: 'color' as const, default: '#123456' } },
};

describe('mods/meta/decorations', () => {
	describe('catalog', () => {
		test('the bundled pack loads and every definition resolves its theme', () => {
			assert.ok(catalog.definitions.size > 0);
			const themes = new Set(catalog.themes.map(theme => theme._id));
			for (const definition of catalog.definitions.values()) {
				assert.ok(themes.has(definition.theme), `unknown theme '${definition.theme}'`);
			}
		});

		test('an unknown theme is fatal', async () => {
			await assert.rejects(
				loadCatalog([ source({ name: 'test', themes: [], decorations: [ landscape ] }) ]), /unknown theme/);
		});

		test('a graphic referencing an unknown property is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, graphics: [ { url: 'https://example.com/a.png', color: 'nope' } ] } ],
			}) ]), /unknown property 'nope'/);
		});

		test('an object overlay without an object type is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, type: 'object' } ],
			}) ]), /names no 'objectType'/);
		});

		test('a malformed pack is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, type: 'somethingElse' as never } ],
			}) ]), /Invalid decoration pack/);
		});

		test('two packs may not share an id', async () => {
			await assert.rejects(loadCatalog([
				source({ name: 'first', themes: [ theme ], decorations: [ landscape ] }),
				source({ name: 'second', themes: [], decorations: [ landscape ] }),
			]), /Duplicate decoration/);
		});

		test('assets are checked and rewritten to their public url', async () => {
			await using directory = await withAssetFile('art/floor.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
			const loaded = await loadCatalog([ source(
				{ name: 'test', themes: [ theme ], decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.svg' } ] },
				directory.url,
			) ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.floorForegroundUrl, 'assets/decorations/test/art/floor.svg');
			assert.ok(loaded.assets.has('test/art/floor.svg'));
		});

		test('external urls are left alone', async () => {
			const loaded = await loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: 'https://example.com/floor.png' } ],
			}) ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.floorForegroundUrl, 'https://example.com/floor.png');
			assert.ok(![ ...loaded.assets.values() ].some(asset => asset.kind === 'file'));
		});

		test('a missing asset is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.svg' } ],
			}) ]), /does not exist/);
		});

		test('an asset outside the pack directory is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: '../floor.svg' } ],
			}) ]), /escapes the pack directory/);
		});

		test('an asset the client cannot render is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.txt' } ],
			}) ]), /unsupported file type/);
		});

		test('a colour property seeded with something else is fatal', async () => {
			await assert.rejects(loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, props: { floorBackgroundColor: { type: 'color', default: 'red' } } } ],
			}) ]), /not a '#rrggbb' colour/);
		});
	});

	describe('previews', () => {
		test('a landscape without artwork gets one drawn from its colours', async () => {
			const loaded = await loadCatalog([ source({ name: 'test', themes: [ theme ], decorations: [ landscape ] }) ]);
			const url = 'assets/decorations/_preview/test/test-floor.svg';
			assert.deepStrictEqual(loaded.definitions.get('test-floor')?.preview, {
				original: url, '128x128': url, '256x256': url,
			});
			const asset = loaded.assets.get('_preview/test/test-floor.svg');
			assert.strictEqual(asset?.kind, 'generated');
			assert.match(asset.body, /^<svg /);
			// The floor colour the pack seeds, undimmed, is what the drawing fills with.
			assert.match(asset.body, /#123456/);
		});

		test('a preview the pack declares wins', async () => {
			await using directory = await withAssetFile('art/tile.png', 'png');
			const loaded = await loadCatalog([ source(
				{ name: 'test', themes: [ theme ], decorations: [ { ...landscape, preview: { '128x128': 'art/tile.png' } } ] },
				directory.url,
			) ]);
			assert.deepStrictEqual(loaded.definitions.get('test-floor')?.preview, {
				'128x128': 'assets/decorations/test/art/tile.png',
			});
			assert.ok(!loaded.assets.has('_preview/test/test-floor.svg'));
		});

		test('a type carrying its own artwork gets none', async () => {
			const loaded = await loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, type: 'wallGraffiti' } ],
			}) ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.preview, undefined);
			assert.strictEqual(loaded.assets.size, 0);
		});

		test('a landscape without the colours to draw gets none', async () => {
			const loaded = await loadCatalog([ source({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, props: {} } ],
			}) ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.preview, undefined);
			assert.strictEqual(loaded.assets.size, 0);
		});

		test('every landscape in the bundled pack has a preview', () => {
			for (const definition of catalog.definitions.values()) {
				if ([ 'floorLandscape', 'wallLandscape', 'landscape' ].includes(definition.type)) {
					assert.ok(definition.preview?.['128x128'] !== undefined, `'${definition._id}' has no preview`);
				}
			}
		});
	});

	describe('ownership', () => {
		test('granted decorations show up, revoked ones do not', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(false);
			const { db } = testShard;
			const [ definition ] = catalog.definitions.values();

			assert.deepStrictEqual(await listForUser(db, alice), []);
			const itemId = await grant(db, alice, definition!._id);
			const owned = await listForUser(db, alice);
			assert.strictEqual(owned.length, 1);
			assert.strictEqual(owned[0]?.id, itemId);
			assert.strictEqual(owned[0].definition._id, definition!._id);

			assert.strictEqual(await revoke(db, alice, itemId), true);
			assert.strictEqual(await revoke(db, alice, itemId), false);
			assert.deepStrictEqual(await listForUser(db, alice), []);
		});

		test('granting something the catalog does not have is an error', async () => {
			await using testShard = await instantiateTestShard();
			await assert.rejects(grant(testShard.db, alice, 'no-such-decoration'), /No such decoration/);
		});

		test('grantAll hands out the whole catalog, keyed by decoration id', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const owned = await listForUser(testShard.db, alice);
			assert.strictEqual(owned.length, catalog.definitions.size);
			for (const item of owned) {
				assert.strictEqual(item.id, item.definition._id);
			}
		});

		test('removing a user drops their decorations', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(false);
			const { db } = testShard;
			const [ definition ] = catalog.definitions.values();

			await grant(db, alice, definition!._id);
			await User.remove(db, alice);
			assert.deepStrictEqual(await listForUser(db, alice), []);
		});
	});

	describe('placement', () => {
		const floor = catalog.definitions.get('xx-floor-plain')!;
		const wall = catalog.definitions.get('xx-wall-plain')!;
		const room = catalog.definitions.get('xx-room-neon')!;

		test('property values are checked against the definition', () => {
			assert.ok('error' in parsePlacement(floor, { shard, room: roomName, nope: 1 }));
			assert.ok('error' in parsePlacement(floor, { shard, room: roomName, floorBackgroundColor: 'red' }));
			assert.ok('error' in parsePlacement(floor, { shard, room: roomName, floorBackgroundBrightness: 99 }));
			assert.ok('error' in parsePlacement(floor, { floorBackgroundColor: '#123456' }), 'a room is required');
		});

		test('numbers and booleans are accepted in their string spelling', () => {
			const placement = parsePlacement(floor, { shard, room: roomName, floorBackgroundBrightness: '0.5', world: 'true' });
			assert.ok(!('error' in placement));
			assert.strictEqual(placement.props.floorBackgroundBrightness, 0.5);
			assert.strictEqual(placement.props.world, true);
		});

		test('properties the client leaves out fall back to the definition seed', () => {
			const placement = parsePlacement(floor, { shard, room: roomName });
			assert.ok(!('error' in placement));
			assert.strictEqual(placement.props.floorBackgroundColor, floor.props.floorBackgroundColor!.default);
		});

		test('what the client sends round-trips back in the same shape', () => {
			const sent = { shard, room: roomName, world: false, floorBackgroundColor: '#abcdef' };
			const placement = parsePlacement(floor, sent);
			assert.ok(!('error' in placement));
			// Flat in, flat out: the target sits next to the property values, never wrapping them.
			const wire = placementToWire(placement);
			assert.strictEqual(wire.shard, shard);
			assert.strictEqual(wire.room, roomName);
			assert.strictEqual(wire.world, false);
			assert.strictEqual(wire.floorBackgroundColor, '#abcdef');
			assert.ok(!('props' in wire));
			// And it parses again unchanged, which is what the client's edit-and-resend does.
			assert.deepStrictEqual(parsePlacement(floor, wire), placement);
		});

		test('a creep decoration names no room, since it follows its owner', () => {
			const creep = { ...floor, _id: 'test-creep', type: 'creep' as const };
			const placement = parsePlacement(creep, {});
			assert.ok(!('error' in placement));
			assert.strictEqual(placement.room, undefined);
			assert.strictEqual(placement.shard, undefined);
		});

		test('a landscape collides with both halves it paints', () => {
			assert.ok(conflicts(room, floor));
			assert.ok(conflicts(room, wall));
			assert.ok(!conflicts(floor, wall));
			assert.ok(conflicts(floor, floor));
		});
	});

	describe('activation', () => {
		/** Placing needs a room the player holds, which the test shard does not hand out. */
		async function ownRoom(testShard: Awaited<ReturnType<typeof instantiateTestShard>>, room = roomName) {
			await insertControlledRoom(testShard.shard, alice, room);
		}

		test('an owned decoration can be placed and shows up in the room', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			assert.strictEqual(await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement()), undefined);
			const placed = await listForRoom(db, shard, roomName);
			assert.strictEqual(placed.length, 1);
			assert.strictEqual(placed[0]?.id, 'xx-floor-plain');
			assert.strictEqual(placed[0].userId, alice);
			assert.strictEqual(placed[0].active.room, roomName);

			const [ item ] = (await listForUser(db, alice)).filter(each => each.id === 'xx-floor-plain');
			assert.strictEqual(item?.active?.room, roomName);
			assert.ok(item.activatedAt !== undefined);
		});

		test('placing in a room the player does not hold is refused', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const result = await activate(testShard.db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			assert.deepStrictEqual(result, { error: 'room not controlled' });
		});

		test('an unknown room is refused', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			await ownRoom(testShard);
			const result = await activate(testShard.db, testShard.shard, alice, 'xx-floor-plain', floorPlacement({ room: 'W99N99' }));
			assert.deepStrictEqual(result, { error: 'unknown room' });
		});

		test('a decoration the player does not own is refused', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(false);
			await ownRoom(testShard);
			const result = await activate(testShard.db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			assert.deepStrictEqual(result, { error: 'not owned' });
		});

		test('a landscape refuses a room that already has a floor', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			const result = await activate(db, testShard.shard, alice, 'xx-room-neon', floorPlacement());
			assert.deepStrictEqual(result, { error: 'already decorated' });
		});

		test('re-activating moves the decoration instead of duplicating it', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);
			await ownRoom(testShard, otherRoomName);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement({ room: otherRoomName }));

			assert.deepStrictEqual(await listForRoom(db, shard, roomName), []);
			assert.strictEqual((await listForRoom(db, shard, otherRoomName)).length, 1);
		});

		test('deactivating takes it back off the map', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			await deactivate(db, alice, [ 'xx-floor-plain' ]);
			assert.deepStrictEqual(await listForRoom(db, shard, roomName), []);
			const [ item ] = (await listForUser(db, alice)).filter(each => each.id === 'xx-floor-plain');
			assert.strictEqual(item?.active, undefined);
		});

		test('a revoke that finds no grant leaves the placement alone', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			// Implicit ownership has no grant to take away, so this fails — without undoing the placement.
			assert.strictEqual(await revoke(db, alice, 'xx-floor-plain'), false);
			assert.strictEqual((await listForRoom(db, shard, roomName)).length, 1);
		});

		test('removing a user takes their placements with them', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			await User.remove(db, alice);
			assert.deepStrictEqual(await listForRoom(db, shard, roomName), []);
		});

		test('the world-map flag survives the round trip through storage', async () => {
			await using testShard = await instantiateTestShard();
			using grantAll = withGrantAll(true);
			const { db } = testShard;
			await ownRoom(testShard);

			// The bundled pack seeds `world` on, so a defaulted placement is map-visible.
			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement());
			const [ shown ] = await listForRoom(db, shard, roomName);
			assert.strictEqual(isOnWorldMap(shown!.active), true);

			await activate(db, testShard.shard, alice, 'xx-floor-plain', floorPlacement({ world: false }));
			const [ hidden ] = await listForRoom(db, shard, roomName);
			assert.strictEqual(isOnWorldMap(hidden!.active), false);
		});
	});
});
