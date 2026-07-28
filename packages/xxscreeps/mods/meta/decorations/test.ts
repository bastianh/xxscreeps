import type { DecorationPack } from './catalog.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from 'xxscreeps/config/index.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { catalog, loadCatalog } from './catalog.js';
import { grant, listForUser, removeAllForUser, revoke } from './model.js';

const alice = '100';

/** Toggle implicit ownership for one test, restoring whatever the config said. */
function withGrantAll(grantAll: boolean) {
	const previous = config.decorations.grantAll;
	config.decorations.grantAll = grantAll;
	return {
		[Symbol.dispose]() {
			config.decorations.grantAll = previous;
		},
	};
}

/** Write a pack (plus any extra files, keyed by relative path) into a temporary directory. */
async function makePack(pack: DecorationPack, files: Record<string, string> = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xxscreeps-pack-'));
	await fs.writeFile(path.join(directory, 'pack.json'), JSON.stringify(pack));
	for (const [ name, content ] of Object.entries(files)) {
		const file = path.join(directory, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	return {
		url: pathToFileURL(path.join(directory, 'pack.json')),
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
			await using pack = await makePack({ name: 'test', themes: [], decorations: [ landscape ] });
			await assert.rejects(loadCatalog([ pack.url ]), /unknown theme/);
		});

		test('a graphic referencing an unknown property is fatal', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, graphics: [ { url: 'https://example.com/a.png', color: 'nope' } ] } ],
			});
			await assert.rejects(loadCatalog([ pack.url ]), /unknown property 'nope'/);
		});

		test('an object overlay without an object type is fatal', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, type: 'object' } ],
			});
			await assert.rejects(loadCatalog([ pack.url ]), /names no 'objectType'/);
		});

		test('a malformed pack is fatal', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, type: 'somethingElse' as never } ],
			});
			await assert.rejects(loadCatalog([ pack.url ]), /Invalid decoration pack/);
		});

		test('two packs may not share an id', async () => {
			await using first = await makePack({ name: 'first', themes: [ theme ], decorations: [ landscape ] });
			await using second = await makePack({ name: 'second', themes: [], decorations: [ landscape ] });
			await assert.rejects(loadCatalog([ first.url, second.url ]), /Duplicate decoration/);
		});

		test('assets are checked and rewritten to their public url', async () => {
			await using pack = await makePack(
				{ name: 'test', themes: [ theme ], decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.svg' } ] },
				{ 'art/floor.svg': '<svg xmlns="http://www.w3.org/2000/svg" />' },
			);
			const loaded = await loadCatalog([ pack.url ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.floorForegroundUrl, '/assets/decorations/test/art/floor.svg');
			assert.ok(loaded.assets.has('test/art/floor.svg'));
		});

		test('external urls are left alone', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: 'https://example.com/floor.png' } ],
			});
			const loaded = await loadCatalog([ pack.url ]);
			assert.strictEqual(loaded.definitions.get('test-floor')?.floorForegroundUrl, 'https://example.com/floor.png');
			assert.strictEqual(loaded.assets.size, 0);
		});

		test('a missing asset is fatal', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.svg' } ],
			});
			await assert.rejects(loadCatalog([ pack.url ]), /does not exist/);
		});

		test('an asset outside the pack directory is fatal', async () => {
			await using pack = await makePack({
				name: 'test',
				themes: [ theme ],
				decorations: [ { ...landscape, floorForegroundUrl: '../floor.svg' } ],
			});
			await assert.rejects(loadCatalog([ pack.url ]), /escapes the pack directory/);
		});

		test('an asset the client cannot render is fatal', async () => {
			await using pack = await makePack(
				{ name: 'test', themes: [ theme ], decorations: [ { ...landscape, floorForegroundUrl: 'art/floor.txt' } ] },
				{ 'art/floor.txt': 'not an image' },
			);
			await assert.rejects(loadCatalog([ pack.url ]), /unsupported file type/);
		});
	});

	describe('ownership', () => {
		test('granted decorations show up, revoked ones do not', async () => {
			await using testShard = await instantiateTestShard();
			using _grantAll = withGrantAll(false);
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
			using _grantAll = withGrantAll(true);
			const owned = await listForUser(testShard.db, alice);
			assert.strictEqual(owned.length, catalog.definitions.size);
			for (const item of owned) {
				assert.strictEqual(item.id, item.definition._id);
			}
		});

		test('removing a user drops their decorations', async () => {
			await using testShard = await instantiateTestShard();
			using _grantAll = withGrantAll(false);
			const { db } = testShard;
			const [ definition ] = catalog.definitions.values();

			await grant(db, alice, definition!._id);
			// The same teardown `User.remove` runs through the hook this mod registers.
			await removeAllForUser(db, alice);
			assert.deepStrictEqual(await listForUser(db, alice), []);
		});
	});
});
