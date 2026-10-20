import type { PlayerLog } from 'xxscreeps/driver/runtime/print.js';
import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { kFdStdError } from 'xxscreeps/driver/runtime/print.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { getConsoleChannel } from 'xxscreeps/engine/runner/model.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { acquireWith, mustNotReject } from 'xxscreeps/utility/async.js';
import { Worker, forkService, waitForChild, waitForWorker } from 'xxscreeps/utility/worker.js';
import { handleInterruptSignal } from './signal.js';
import { getServiceChannel } from './index.js';

const argv = checkArguments({
	boolean: [ 'no-backend', 'no-processor', 'no-runner' ] as const,
	string: [ 'attach-console', 'shard' ] as const,
});

// A single-threaded launcher runs every service in this process, where one module specifier
// resolves to one cached instance. A second shard would silently share the first shard's services
// instead of getting its own, so refuse the combination rather than run a broken world.
const singleThreaded = config.launcher?.singleThreaded;
if (singleThreaded && config.shards.length > 1) {
	throw new Error(`\`launcher.singleThreaded\` runs a single shard, but ${config.shards.length} are configured`);
}

// Connect to shards
await using db = await Database.connect();
await using disposable = new AsyncDisposableStack();
const shards = await acquireWith(
	resource => disposable.use(resource),
	...Fn.map(config.shards, info => Shard.connect(db, info.name)));

// Open databases, saving on exit (graceful or not). The local database providers save
// asynchronously so the "disconnect" effect can't do it. Since the redis provider continually saves
// on its own, saving even on ungraceful exit brings them more in line.
// nb: Deferred after the shards were adopted above, so it runs while they're all still connected.
disposable.defer(async () => {
	await Promise.all([ db.save(), ...Fn.map(shards, shard => shard.save()) ]);
	console.log('💾 Engine shut down successfully.');
});

// Attach console for given user. A console belongs to one shard, so `--shard` selects which.
if (argv['attach-console'] !== undefined) {
	const shardName = argv.shard ?? config.shards[0]!.name;
	const shard = shards.find(candidate => candidate.name === shardName);
	if (!shard) {
		throw new Error(`Unknown shard: ${shardName}`);
	}
	const id = await User.findUserByName(db, argv['attach-console']);
	if (id === null) {
		throw new Error(`User: ${argv['attach-console']} not found`);
	}
	const channel = disposable.adopt(
		await getConsoleChannel(shard, id).subscribe(),
		subscription => subscription.disconnect());
	channel.listen(message => {
		for (const line of JSON.parse(message) as PlayerLog[]) {
			if (line.fd === kFdStdError) {
				console.error(line.data);
			} else {
				console.log(line.data);
			}
		}
	});
}

// Start a main service per shard. Each shard's listener is installed before its service starts, so
// a 'mainConnected' published right away can't be missed.
const mains = await async function() {
	using disposable = new DisposableStack();
	const pending = shards.map(shard => {
		const [ effect, waitForMain ] = getServiceChannel(shard).listenFor(message => message.type === 'mainConnected');
		disposable.defer(effect);
		// nb: When single-threaded 'main' runs in this process, which is limited to one shard above.
		const main = singleThreaded
			? import('./main.js')
			: waitForWorker(Worker.create('xxscreeps/engine/service/main.js', { argv: [ '--shard', shard.name ] }));
		return { main, waitForMain };
	});
	await Promise.all(pending.map(({ main, waitForMain }) => Promise.race([ main, waitForMain ])));
	// nb: Do not wait on 'main' to complete here
	return pending.map(({ main }) => main);
}();

// Interrupt handler (after 'main' initialized). If it hasn't initialized then the default 'SIGINT'
// will just terminate.
using signal = handleInterruptSignal(() => {
	console.log('Shutting down...');
	mustNotReject(Fn.mapAwait(shards, shard => getServiceChannel(shard).publish({ type: 'shutdown' })));
});

// Start workers
const { services, backend } = function() {
	if (singleThreaded) {
		const backend = argv['no-backend'] ? null : import('xxscreeps/backend/server.js');
		// eslint-disable-next-line no-useless-concat
		const processor = argv['no-processor'] ? null : import('./processor.js' + '?launcher');
		// eslint-disable-next-line no-useless-concat
		const runner = argv['no-runner'] ? null : import('./runner.js' + '?launcher');
		const services = Promise.all([ ...mains, processor, runner ]);
		return { services, backend };
	} else {
		const backend = argv['no-backend'] ? null : Worker.create('xxscreeps/backend/server.js');
		const processors = shards.map(shard => argv['no-processor'] ? null :
			Worker.create('xxscreeps/engine/service/processor.js', { argv: [ '--shard', shard.name ] }));
		// nb: Runners get a process each rather than a thread each; see `forkService`.
		const runners = shards.map(shard => argv['no-runner'] ? null :
			forkService('xxscreeps/engine/service/runner.js', [ '--shard', shard.name ]));
		// Nothing reaps a forked child on an ungraceful exit, so make sure none outlive the launcher.
		disposable.defer(() => {
			for (const runner of runners) {
				runner?.kill();
			}
		});
		const services = Promise.all([
			...mains,
			...processors.map(processor => waitForWorker(processor)),
			...runners.map(runner => waitForChild(runner)),
		]);
		return { services, backend };
	}
}();
await Promise.all([ services, backend ]);
