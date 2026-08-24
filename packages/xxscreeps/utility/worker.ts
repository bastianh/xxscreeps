import type { ChildProcess } from 'node:child_process';
import type { WorkerOptions } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as PubSub from 'xxscreeps/engine/db/storage/local/pubsub.js';
import * as Responder from 'xxscreeps/engine/db/storage/local/responder.js';

const trampoline = () => new URL(import.meta.resolve('xxscreeps/xxscreeps.js'));

export class Worker extends NodeWorker {
	constructor(filename: string | URL, options: WorkerOptions = {}) {
		super(filename, {
			...options,
		});
		PubSub.initializeWorker(this);
		Responder.initializeWorker(this);
	}

	// The worker boots through the `xxscreeps.js` trampoline, which shifts the module specifier off
	// `process.argv` before handing over. Anything passed as `argv` lands behind it, where the
	// service's own `checkArguments` will find it.
	static create(module: string, options: Omit<WorkerOptions, 'argv'> & { argv?: string[] | undefined } = {}) {
		const url = import.meta.resolve(module);
		return new Worker(trampoline(), {
			...options,
			argv: [ url, ...options.argv ?? [] ],
		});
	}
}

/**
 * Runs a service in a process of its own, rather than a thread of this one.
 *
 * Native addons are registered per process, and `ivm-inspect` (which every isolated sandbox needs
 * for `util.inspect`) is built on nan, so only one thread per process may ever load it. Services
 * which create sandboxes therefore can't be threads once there is more than one of them. They reach
 * the local storage providers as a sibling process over the configured `?socket=` paths.
 */
export function forkService(module: string, argv: string[] = []) {
	const url = import.meta.resolve(module);
	return fork(fileURLToPath(trampoline()), [ url, ...argv ]);
}

export function waitForWorker(worker: Worker): Promise<void>;
export function waitForWorker(worker: Worker | null): Promise<void> | undefined;
export function waitForWorker(worker: Worker | null) {
	if (worker) {
		return new Promise<void>((resolve, reject) => {
			worker.on('exit', code => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Worker exited with code: ${code}`));
				}
			});
		});
	}
}

export function waitForChild(child: ChildProcess): Promise<void>;
export function waitForChild(child: ChildProcess | null): Promise<void> | undefined;
export function waitForChild(child: ChildProcess | null) {
	if (child) {
		return new Promise<void>((resolve, reject) => {
			// A child killed by a signal reports a null code. That's how it exits when the whole process
			// group is interrupted, so it isn't a failure.
			child.on('exit', (code, signal) => {
				if (code === 0 || signal !== null) {
					resolve();
				} else {
					reject(new Error(`Service exited with code: ${code}`));
				}
			});
		});
	}
}
