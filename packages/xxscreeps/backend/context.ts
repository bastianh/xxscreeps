import type { World } from 'xxscreeps/game/map.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { acquireWith } from 'xxscreeps/utility/async.js';
import { AsyncDisposableResource } from 'xxscreeps/utility/utility.js';

/**
 * Everything the backend holds open for one shard. The backend serves every configured shard from
 * a single process, so this is the unit a request or subscription resolves to.
 */
export interface ShardContext {
	readonly shard: Shard;
	readonly world: World;
	readonly accessibleRooms: ReadonlySet<string>;
}

async function connectShard(db: Database, name: string): Promise<[ Shard, ShardContext ]> {
	const shard = await Shard.connect(db, name);
	const [ world, rooms ] = await Promise.all([ shard.loadWorld(), shard.data.sMembers('rooms') ]);
	return [ shard, { shard, world, accessibleRooms: new Set(rooms) } ];
}

export class BackendContext extends AsyncDisposableResource {
	readonly db;
	readonly shards;
	readonly defaultShard;

	private constructor(disposable: AsyncDisposableStack, db: Database, shards: ReadonlyMap<string, ShardContext>) {
		super(disposable);
		this.db = db;
		this.shards = shards;
		// The first configured shard answers for clients which don't name one, and for routes which
		// aren't shard-scoped in the first place.
		this.defaultShard = shards.get(config.shards[0]!.name)!;
	}

	static async connect() {
		// Connect to services
		await using disposable = new AsyncDisposableStack();
		const db = disposable.use(await Database.connect());
		const connected = await acquireWith(
			([ shard ]: [ Shard, ShardContext ]) => disposable.use(shard),
			...Fn.map(config.shards, info => connectShard(db, info.name)));
		const shards = new Map(Fn.map(connected, ([ , context ]) => [ context.shard.name, context ] as const));
		return new BackendContext(disposable.move(), db, shards);
	}

	/**
	 * Resolves the shard a request addressed. An absent name means the client didn't pick one; a
	 * name which isn't configured never falls back to the default, since answering with another
	 * shard's world would be worse than answering with nothing.
	 */
	findShard(name: string | undefined) {
		return name === undefined ? this.defaultShard : this.shards.get(name);
	}

	/** `findShard` for callers which have no way to report the failure themselves. */
	shardFor(name: string | undefined) {
		const context = this.findShard(name);
		if (!context) {
			throw new Error(`Unknown shard: ${name!}`);
		}
		return context;
	}
}
