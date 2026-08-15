import type { Shard } from 'xxscreeps/engine/db/index.js';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hooks as driverHooks } from 'xxscreeps/driver/index.js';
import * as Code from 'xxscreeps/engine/db/user/code.js';
import { hooks as processorHooks } from 'xxscreeps/engine/processor/symbols.js';
import { hooks as runnerHooks } from 'xxscreeps/engine/runner/index.js';

const userCpuHistogramBucketsMs = [ 1, 2, 5, 10, 20, 50, 100, 200, 500 ];

function recordUserHistogram(shard: Shard, keyBase: string, username: string, value: number, buckets: readonly number[]) {
	const rounded = Math.max(0, Math.round(value));
	const tasks: Promise<unknown>[] = [
		shard.scratch.hincrBy(`${keyBase}/sum`, username, rounded),
		shard.scratch.hincrBy(`${keyBase}/count`, username, 1),
		shard.scratch.hincrBy(`${keyBase}/bucket/+Inf`, username, 1),
	];
	for (const bucket of buckets) {
		if (rounded <= bucket) {
			tasks.push(shard.scratch.hincrBy(`${keyBase}/bucket/${bucket}`, username, 1));
		}
	}
	return Promise.all(tasks);
}

// Helper: start the process-wide memory reporter once per process (runner or processor worker).
let processReporterStarted = false;
function startProcessMetricsReporter(shard: Shard, service: 'runner' | 'processor') {
	if (processReporterStarted) {
		return;
	}
	processReporterStarted = true;

	const pid = process.pid;
	const instance = `${process.env.HOSTNAME ?? hostname()}:${pid}:t${threadId}`;
	const reportMemory = async () => {
		try {
			const heap = process.memoryUsage();
			const key = `prometheus/process:${service}:${instance}`;
			await Promise.all([
				shard.scratch.set(key, JSON.stringify({
					rss: heap.rss,
					heapTotal: heap.heapTotal,
					heapUsed: heap.heapUsed,
					external: heap.external,
					service,
					instance,
					pid,
				}), { px: 30000 }),
				shard.scratch.sAdd('prometheus/active_processes', [ key ]),
			]);
		} catch (err) {
			console.error(`Failed to report ${service} process memory metrics:`, err);
		}
	};
	void reportMemory();
	setInterval(() => void reportMemory(), 10000);
}

declare module 'xxscreeps/engine/runner/index.js' {
	interface TickUsageResult {
		heapUsed?: number;
		heapTotal?: number;
	}
}

interface IsolateHeapStatistics {
	used_heap_size: number;
	total_heap_size: number;
}

// `isolate` is a private implementation detail of `IsolatedSandbox`, not part of the public
// `Sandbox` interface, so this reaches past the type system to read it.
function readIsolateHeapStatistics(sandbox: unknown): IsolateHeapStatistics | undefined {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	const isolate = (sandbox as any).isolate as { getHeapStatisticsSync?: () => IsolateHeapStatistics } | undefined;
	if (typeof isolate?.getHeapStatisticsSync === 'function') {
		try {
			return isolate.getHeapStatisticsSync();
		} catch {
			// Isolate may already be disposed
			return undefined;
		}
	}
	return undefined;
}

// Decorate `sandbox.run` to capture isolate VM heap statistics right after a successful tick.
driverHooks.register('sandboxCreated', sandbox => {
	const originalRun = sandbox.run;
	sandbox.run = async data => {
		const completion = await originalRun.call(sandbox, data);
		if (completion.result === 'success') {
			const heap = readIsolateHeapStatistics(sandbox);
			if (heap) {
				completion.payload.usage.heapUsed = heap.used_heap_size;
				completion.payload.usage.heapTotal = heap.total_heap_size;
			} else {
				// Fallback for the 'unsafe' nodejs sandbox, which has no isolate
				const processHeap = process.memoryUsage();
				completion.payload.usage.heapUsed = processHeap.heapUsed;
				completion.payload.usage.heapTotal = processHeap.heapTotal;
			}
		}
		return completion;
	};
});

// Runner-phase timing (approximate): there is no core "runner finished this tick" signal to bound
// this against, so it tracks the span between the first `refresh()` seen for a tick and the last
// `save()` seen before the next tick's first `refresh()`. Players run concurrently in
// concurrency-limited batches with a migration-timeout straggler window, and dispatch overlaps the
// processor phase's wall-clock window (both are published together in `engine/service/main.ts`), so
// treat this as an approximate signal rather than a disjoint phase duration.
let runnerPhaseTime: number | undefined;
let runnerPhaseStartedAt: number | undefined;
let runnerPhaseLastActivityAt: number | undefined;

function finalizeRunnerPhase(shard: Shard) {
	if (runnerPhaseTime === undefined || runnerPhaseStartedAt === undefined || runnerPhaseLastActivityAt === undefined) {
		return;
	}
	const duration = Math.max(0, runnerPhaseLastActivityAt - runnerPhaseStartedAt);
	const time = runnerPhaseTime;
	Promise.all([
		shard.scratch.set('prometheus/runner_phase_ms', String(Math.round(duration))),
		shard.scratch.set('prometheus/runner_phase_tick_time', String(time)),
	]).catch(err => console.error('Failed to report runner phase metrics:', err));
}

runnerHooks.register('runnerConnector', player => {
	const { shard, username } = player;
	startProcessMetricsReporter(shard, 'runner');

	return [ () => {}, {
		async initialize() {
			// `branchName` is private in TypeScript but accessible at runtime
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			const branchName = (player as any).branchName as string | null;
			const tasks: Promise<unknown>[] = [
				shard.scratch.hincrBy('prometheus/user_vm_resets_total', username, 1),
				shard.scratch.hSet('prometheus/user_last_reset_tick', username, String(shard.time)),
			];
			if (branchName !== null) {
				const [ buffersBlob, stringsBlob ] = await Promise.all([
					shard.db.data.get(Code.buffersKey(player.userId, branchName), { blob: true }),
					shard.db.data.get(Code.stringsKey(player.userId, branchName), { blob: true }),
				]);
				const codeSize = (buffersBlob?.byteLength ?? 0) + (stringsBlob?.byteLength ?? 0);
				tasks.push(shard.scratch.hSet('prometheus/user_code_size_bytes', username, String(codeSize)));
			}
			await Promise.all(tasks);
		},

		refresh(payload) {
			const now = Date.now();
			if (runnerPhaseTime !== payload.time) {
				finalizeRunnerPhase(shard);
				runnerPhaseTime = payload.time;
				runnerPhaseStartedAt = now;
			}
			runnerPhaseLastActivityAt = now;
		},

		async save(payload) {
			runnerPhaseLastActivityAt = Date.now();

			const cpu = payload.usage.cpu ?? 0;
			const memory = payload.usage.memory;
			const heapUsed = payload.usage.heapUsed;
			const heapTotal = payload.usage.heapTotal;

			const tasks: Promise<unknown>[] = [
				recordUserHistogram(shard, 'prometheus/user_cpu_tick_ms_histogram', username, cpu, userCpuHistogramBucketsMs),
			];
			if (cpu > 0) {
				tasks.push(shard.scratch.hincrBy('prometheus/user_cpu_total_ms', username, Math.round(cpu)));
			}
			if (memory !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_game_memory_bytes', username, String(memory)));
			}
			if (heapUsed !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_heap_used_bytes', username, String(heapUsed)));
			}
			if (heapTotal !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_heap_total_bytes', username, String(heapTotal)));
			}
			await Promise.all(tasks);
		},
	} ];
});

// Processor worker memory reporting: this engine version has no `workerInitialized` hook, so this
// piggybacks on `refreshRoom`, which fires once per room whenever "processor continuity has broken"
// -- in practice including the initial room load every worker performs at startup, which is close
// enough to "worker started" for a memory gauge. Edge case: a worker that is never assigned a room
// never reports.
processorHooks.register('refreshRoom', shard => {
	startProcessMetricsReporter(shard, 'processor');
	return Promise.resolve();
});
