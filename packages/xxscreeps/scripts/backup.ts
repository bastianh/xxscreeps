// Copies a whole server out and back: `xxscreeps backup` walks every key of the database and of
// each configured shard into one file, `xxscreeps restore` writes that file back. Both are entry
// points into this module; run after `tsc -b`.
//
// This works at the key/value layer, underneath the game model, so it carries whatever the running
// build put there -- users, code, rooms, memory, schema archives, anything a mod wrote -- without
// knowing what any of it means. That also makes it the wrong tool for a version migration: the
// build reading a backup back has to understand the blobs inside it, so restore onto the same
// version of xxscreeps or a newer one.
//
// Both ends want a stopped server. Backup holds each shard's game mutex, so a server which is up
// but paused cannot tick mid-scan; restore replaces the target's contents outright and has nothing
// to synchronize against.
import type { KeyType, KeyValProvider } from 'xxscreeps/engine/db/storage/provider.js';
import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { inspect } from 'node:util';
import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { getOrSet } from 'xxscreeps/utility/utility.js';

/** Bumped whenever a reader could no longer make sense of an older file. */
const magic = 'xxscreeps-backup 1\n';

interface StoreInfo {
	name: string;
	/**
	 * Taken from the source provider, because it decides whether this store's `bytes` entries can be
	 * filed anywhere on the way back in. See `KeyType`.
	 */
	separatesBlobs: boolean;
}

interface HeaderRecord {
	kind: 'header';
	created: number;
	stores: StoreInfo[];
}

interface EntryBase {
	kind: 'entry';
	store: string;
	key: string;
}

/** The value trails the record as raw bytes rather than riding along base64'd inside it. */
interface BinaryEntry extends EntryBase {
	type: 'blob' | 'bytes';
	length: number;
}

interface StringEntry extends EntryBase {
	type: 'string';
	value: string;
}

interface HashEntry extends EntryBase {
	type: 'hash';
	value: Record<string, string>;
}

interface MembersEntry extends EntryBase {
	type: 'list' | 'set';
	value: string[];
}

interface ScoredEntry extends EntryBase {
	type: 'zset';
	value: [ score: number, member: string ][];
}

type EntryRecord = BinaryEntry | HashEntry | MembersEntry | ScoredEntry | StringEntry;

/** Closes the file, so a truncated backup is caught instead of read as a short one. */
interface EndRecord {
	kind: 'end';
	entries: number;
}

type BackupRecord = EndRecord | EntryRecord | HeaderRecord;

interface Store {
	name: string;
	data: KeyValProvider;
	/**
	 * Per-tick state, which references the world it was built from. It is never backed up, and a
	 * restore has to clear it or the next tick picks up where another server left off.
	 */
	scratch?: KeyValProvider;
}

const out = (line: string) => process.stdout.write(`${line}\n`);

function *frame(record: BackupRecord, payload?: Readonly<Uint8Array>) {
	const meta = Buffer.from(JSON.stringify(record), 'utf8');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(meta.length);
	yield length;
	yield meta;
	if (payload) {
		yield payload;
	}
}

/** Pulls fixed-length pieces out of a byte stream. Every record is framed, so an EOF inside one is
 * truncation -- the head of the file is the one place a short read means something else. */
class BackupReader {
	private readonly chunks: Buffer[] = [];
	private length = 0;
	private readonly source;

	constructor(source: AsyncIterable<Buffer>) {
		this.source = source[Symbol.asyncIterator]();
	}

	async read(size: number): Promise<Buffer> {
		return await this.readOptional(size) ?? function(): never {
			throw new Error('Backup ends mid-record');
		}();
	}

	/**
	 * Answers `undefined` where `read` would throw, for the one read which tolerates a stream
	 * ending early: the magic at the head of a file which may not be a backup at all. Trouble
	 * reaching the file still comes back as itself.
	 */
	async readOptional(size: number): Promise<Buffer | undefined> {
		while (this.length < size) {
			const next = await this.source.next();
			if (next.done) {
				return;
			}
			this.chunks.push(next.value);
			this.length += next.value.length;
		}
		const buffer = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.length);
		this.chunks.length = 0;
		this.length -= size;
		if (this.length > 0) {
			this.chunks.push(buffer.subarray(size));
		}
		return buffer.subarray(0, size);
	}

	async readRecord(): Promise<BackupRecord> {
		const length = (await this.read(4)).readUInt32BE();
		return JSON.parse((await this.read(length)).toString('utf8')) as BackupRecord;
	}
}

async function *readEntries(file: string, reader: BackupReader) {
	let count = 0;
	while (true) {
		const record = await reader.readRecord();
		if (record.kind === 'end') {
			if (record.entries !== count) {
				throw new Error(`'${file}' promises ${record.entries} entries but holds ${count}`);
			}
			return;
		} else if (record.kind !== 'entry') {
			throw new Error(`'${file}' holds a second '${record.kind}' record`);
		}
		++count;
		const payload = record.type === 'blob' || record.type === 'bytes'
			? await reader.read(record.length) : undefined;
		yield { entry: record, payload };
	}
}

/** Reads a backup's header, along with an iterator over the entries behind it. */
async function openBackup(file: string) {
	const reader = new BackupReader(createReadStream(file));
	// A file too short to even hold the magic is simply not one of ours
	const opening = await reader.readOptional(magic.length);
	if (opening?.toString('utf8') !== magic) {
		throw new Error(`'${file}' is not an xxscreeps backup`);
	}
	const header = await reader.readRecord();
	if (header.kind !== 'header') {
		throw new Error(`'${file}' opens with a '${header.kind}' record`);
	}
	return { entries: readEntries(file, reader), header };
}

async function *scanAll(provider: KeyValProvider) {
	let cursor = '0';
	do {
		const result = await provider.scan(cursor);
		yield* result.entries;
		cursor = result.cursor;
	} while (cursor !== '0');
}

/**
 * Reads one key by the shape `scan` reported for it. Yields nothing when the key has gone missing
 * since the scan, which a scan makes no promise against.
 */
async function readEntry(store: Store, key: string, type: KeyType): Promise<readonly [ EntryRecord, Readonly<Uint8Array>? ] | undefined> {
	const head = { kind: 'entry', store: store.name, key } as const;
	switch (type) {
		case 'blob': case 'bytes': {
			const value = await store.data.get(key, { blob: true });
			return value === null ? undefined : [ { ...head, type, length: value.length }, value ];
		}

		case 'string': {
			const value = await store.data.get(key);
			return value === null ? undefined : [ { ...head, type, value } ];
		}

		case 'hash': {
			const value = await store.data.hGetAll(key);
			return Object.keys(value).length === 0 ? undefined : [ { ...head, type, value } ];
		}

		case 'list': case 'set': {
			const value = type === 'list'
				? await store.data.lRange(key, 0, -1)
				: await store.data.sMembers(key);
			return value.length === 0 ? undefined : [ { ...head, type, value } ];
		}

		case 'zset': {
			const value = await store.data.zRangeWithScores(key, 0, -1);
			return value.length === 0 ? undefined : [ { ...head, type, value } ];
		}
	}
}

function writeEntry(provider: KeyValProvider, entry: EntryRecord, payload: Readonly<Uint8Array> | undefined) {
	switch (entry.type) {
		case 'blob': case 'bytes': return provider.set(entry.key, payload!);
		case 'string': return provider.set(entry.key, entry.value);
		case 'hash': return provider.hmSet(entry.key, entry.value);
		case 'list': return provider.rPush(entry.key, entry.value);
		case 'set': return provider.sAdd(entry.key, entry.value);
		case 'zset': return provider.zAdd(entry.key, entry.value);
	}
}

/**
 * Connects the database and every configured shard, and hands them over as one flat list of stores.
 * The shards come along separately because a backup needs their mutexes.
 */
async function withStores<Type>(callback: (stores: Store[], shards: Shard[]) => Promise<Type>) {
	await using disposable = new AsyncDisposableStack();
	const db = disposable.use(await Database.connect());
	const shards: Shard[] = [];
	for (const { name } of config.shards) {
		shards.push(disposable.use(await Shard.connect(db, name)));
	}
	const stores = [
		{ name: 'database', data: db.data },
		...Fn.map(shards, shard => ({ name: `shard/${shard.name}`, data: shard.data, scratch: shard.scratch })),
	];
	return await callback(stores, shards);
}

async function backup(file: string) {
	await withStores(async (stores, shards) => {
		// Hold every shard's game mutex so a running-but-paused server can't commit a tick into the
		// middle of the scan. With no server up these are uncontended.
		await using disposable = new AsyncDisposableStack();
		for (const shard of shards) {
			const mutex = disposable.use(await Mutex.connect('game', shard.data, shard.pubsub));
			disposable.use(await mutex.acquire());
		}

		const header: HeaderRecord = {
			kind: 'header',
			created: Date.now(),
			stores: await Fn.mapAwait(stores, async store => ({
				name: store.name,
				separatesBlobs: await store.data.separatesBlobs(),
			})),
		};
		// Written beside the destination and renamed at the end, so a run which dies partway can't
		// leave behind something that opens like a whole backup.
		const tmp = `${file}.tmp`;
		let entries = 0;
		await pipeline(async function*() {
			yield Buffer.from(magic, 'utf8');
			yield* frame(header);
			for (const store of stores) {
				const seen = new Set<string>();
				let written = 0;
				for await (const [ key, type ] of scanAll(store.data)) {
					// A scan may hand the same key back twice -- redis repeats keys across batches,
					// and a local key written both as text and as binary is reported from either
					// store -- and a second copy would append itself to whatever list or set the
					// first one wrote
					if (seen.has(key)) {
						continue;
					}
					seen.add(key);
					// A key which expires is transient -- the game mutex this very scan is holding,
					// a login session -- and a backup has nowhere to put the time it has left, so
					// restoring it as a permanent key would be worse than leaving it out. Asked for
					// alongside the read so that redis answers both in one round trip.
					const [ ttl, record ] = await Promise.all([
						store.data.pTTL(key),
						readEntry(store, key, type),
					]);
					if (ttl >= 0) {
						continue;
					} else if (record === undefined) {
						out(`Skipped ${store.name} ${key}, which disappeared mid-scan`);
					} else {
						++written;
						++entries;
						yield* frame(...record);
					}
				}
				out(`${store.name}: ${written} key(s)`);
			}
			yield* frame({ kind: 'end', entries });
		}(), createWriteStream(tmp));
		await fs.rename(tmp, file);

		const { size } = await fs.stat(file);
		out(`Wrote ${entries} entr(ies), ${size} bytes to ${file}.`);
	});
}

async function restore(file: string, force: boolean) {
	await withStores(async stores => {
		const byName = new Map(Fn.map(stores, store => [ store.name, store ] as const));
		const { entries: records, header } = await openBackup(file);

		// Everything which makes this refuse is settled here, before anything is erased
		const sources = await Fn.mapAwait(header.stores, async source => {
			const target = byName.get(source.name);
			if (target === undefined) {
				throw new Error(`Backup holds '${source.name}', which this config does not configure`);
			} else if (!source.separatesBlobs && await target.data.separatesBlobs()) {
				throw new Error(
					`'${source.name}' was backed up from a provider which files text and binary together, ` +
					'and this one keeps them apart -- it cannot tell which is which. Restore onto a ' +
					'provider of the same kind as the source.');
			}
			return target;
		});
		if (!force) {
			// Everything above has passed, so this describes a restore which would go through, and
			// still leaves as a failure: the command was asked to restore and did not
			await describe(header, records);
			throw new Error(`This replaces ${[ ...Fn.map(sources, store => store.name) ].join(', ')} outright. Pass --force to go ahead.`);
		}

		// Only the stores the header named are cleared, so those are also the only ones an entry may
		// be filed into -- anything else would merge a backup into a store still holding a world
		const targets = new Map(Fn.map(sources, store => [ store.name, store ] as const));
		await Fn.mapAwait(sources, store => Promise.all([ store.data.flushdb(), store.scratch?.flushdb() ]));
		out(`Cleared ${sources.length} store(s).`);

		let entries = 0;
		for await (const { entry, payload } of records) {
			const store = targets.get(entry.store);
			if (store === undefined) {
				throw new Error(`Entry '${entry.key}' names store '${entry.store}', which the header omits`);
			}
			await writeEntry(store.data, entry, payload);
			++entries;
		}
		await Fn.mapAwait(sources, store => Promise.all([ store.data.save(), store.scratch?.save() ]));
		out(`Restored ${entries} entr(ies) from ${file}.`);
	});
}

/** Reports what a backup holds, counted off the file rather than off the header. */
async function describe(header: HeaderRecord, entries: AsyncIterable<{ entry: EntryRecord }>) {
	const counts = new Map<string, Map<KeyType, number>>();
	for await (const { entry } of entries) {
		const byType = getOrSet(counts, entry.store, () => new Map());
		byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
	}
	out(`Created: ${new Date(header.created).toISOString()}`);
	for (const store of header.stores) {
		out(`${store.name}${store.separatesBlobs ? '' : ' (text and binary indistinguishable)'}`);
		for (const [ type, count ] of counts.get(store.name) ?? []) {
			out(`  ${type.padEnd(6)} ${count}`);
		}
	}
}

const command = process.argv[1];
if (command === 'backup' || command === 'restore') {
	const argv = checkArguments({ argv: true, boolean: [ 'force' ] as const });
	const file = argv.argv[0];
	if (file === undefined) {
		console.log(command === 'backup'
			? 'Usage: xxscreeps backup <file>'
			: 'Usage: xxscreeps restore <file> [--force]');
		process.exitCode = 1;
	} else {
		try {
			await (command === 'backup' ? backup(file) : restore(file, argv.force));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A failed connect arrives as an `AggregateError`, which keeps its detail in `errors` and
			// leaves `message` empty -- printing that alone would say nothing at all
			process.stderr.write(`${message === '' ? inspect(err) : message}\n`);
			process.exitCode = 1;
		}
	}
}
