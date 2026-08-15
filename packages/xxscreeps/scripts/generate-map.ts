import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { parseRoomOptions, roomOptionArguments } from 'xxscreeps/scripts/generate-room.js';
import { generateSector } from 'xxscreeps/scripts/room-gen.js';

// Generates many sectors in one shard connection, so a multi-sector map doesn't pay a fresh
// container + process + database connection per sector the way repeated `generate-sector` calls
// would. Sequential, not parallel: each sector's terrain read must see the previous sector's
// writes so shared highway rings line up.
async function main() {
	const argv = checkArguments({
		argv: true,
		string: [ 'shard', ...roomOptionArguments ] as const,
	});
	const origins = argv.argv.filter(origin => origin !== undefined);
	if (origins.length === 0) {
		console.log('Usage: xxscreeps generate-map <origin>... [--shard shard] [--terrain-type 1-28] [--swamp-type 0-14] [--sources 1-4] [--mineral H|O|Z|K|U|L|X]');
		process.exitCode = 1;
		return;
	}

	const options = parseRoomOptions(argv);
	await using db = await Database.connect();
	await using shard = await Shard.connect(db, argv.shard ?? config.shards[0]!.name);
	let total = 0;
	for (const origin of origins) {
		const rooms = await generateSector(shard, origin, options);
		total += rooms.length;
		console.log(`Generated ${rooms.length} room${rooms.length === 1 ? '' : 's'} from ${origin}`);
	}
	await Promise.all([ db.save(), shard.save() ]);
	console.log(`Generated ${total} room${total === 1 ? '' : 's'} total from ${origins.length} sector${origins.length === 1 ? '' : 's'}`);
}

if (process.argv[1] === 'generate-map') {
	await main();
}
