import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hooks as driverHooks } from 'xxscreeps/driver/index.js';
import { hooks as runnerHooks } from 'xxscreeps/engine/runner/index.js';
import { hooks as processorHooks } from 'xxscreeps/engine/processor/symbols.js';
import * as Code from 'xxscreeps/engine/db/user/code.js';

const userCpuHistogramBucketsMs = [ 1, 2, 5, 10, 20, 50, 100, 200, 500 ];

function recordUserHistogram(shard: any, keyBase: string, username: string, value: number, buckets: readonly number[]) {
	const rounded = Math.max(0, Math.round(value));
	const tasks: Promise<any>[] = [
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

// Extend TickUsageResult to support VM heap statistics
declare module 'xxscreeps/engine/runner/index.js' {
	interface TickUsageResult {
		heapUsed?: number;
		heapTotal?: number;
	}
}

// 1. Sandbox creation hook: Decorate sandbox.run to capture isolate VM heap statistics
driverHooks.register('sandboxCreated', (sandbox, userId) => {
	const originalRun = sandbox.run;
	sandbox.run = async (data) => {
		const completion = await originalRun.call(sandbox, data);
		if (completion.result === 'success') {
			const isolate = (sandbox as any).isolate;
			if (isolate && typeof isolate.getHeapStatisticsSync === 'function') {
				try {
					const heap = isolate.getHeapStatisticsSync();
					completion.payload.usage.heapUsed = heap.used_heap_size;
					completion.payload.usage.heapTotal = heap.total_heap_size;
				} catch (err) {
					// Suppress errors (e.g. if isolate has already been disposed)
				}
			} else {
				// Fallback to local process memory usage if running in unsafe nodejs sandbox
				try {
					const heap = process.memoryUsage();
					completion.payload.usage.heapUsed = heap.heapUsed;
					completion.payload.usage.heapTotal = heap.heapTotal;
				} catch (err) {}
			}
		}
		return completion;
	};
});

// 2. runnerConnector hook: Record player CPU, persistent memory size, and VM isolate heap sizes to Redis
runnerHooks.register('runnerConnector', player => {
	const { shard, username } = player;

	// Start the process metrics reporter for the runner process
	startProcessMetricsReporter(shard, 'runner');

	return [ () => {}, {
		async initialize(_payload) {
			// branchName is private in TypeScript but accessible at runtime
			const branchName = (player as any).branchName as string | null;
			const tasks: Promise<any>[] = [
				shard.scratch.hincrBy('prometheus/user_vm_resets_total', username, 1),
				shard.scratch.hSet('prometheus/user_last_reset_tick', username, String(shard.time)),
			];
			if (branchName) {
				const [ buffersBlob, stringsBlob ] = await Promise.all([
					shard.db.data.get(Code.buffersKey(player.userId, branchName), { blob: true }),
					shard.db.data.get(Code.stringsKey(player.userId, branchName), { blob: true }),
				]);
				const codeSize = (buffersBlob?.byteLength ?? 0) + (stringsBlob?.byteLength ?? 0);
				tasks.push(shard.scratch.hSet('prometheus/user_code_size_bytes', username, String(codeSize)));
			}
			await Promise.all(tasks);
		},

		async refresh(_payload) {
			startProcessMetricsReporter(shard, 'runner');
		},

		async save(payload) {
			const cpu = payload.usage.cpu ?? 0;
			const memory = payload.usage.memory;
			const heapUsed = payload.usage.heapUsed;
			const heapTotal = payload.usage.heapTotal;

			const tasks: Promise<any>[] = [];

			if (cpu > 0) {
				tasks.push(shard.scratch.hincrBy('prometheus/user_cpu_total_ms', username, Math.round(cpu)));
			}
			tasks.push(recordUserHistogram(shard, 'prometheus/user_cpu_tick_ms_histogram', username, cpu, userCpuHistogramBucketsMs));
			if (memory !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_game_memory_bytes', username, String(memory)));
			}
			if (heapUsed !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_heap_used_bytes', username, String(heapUsed)));
			}
			if (heapTotal !== undefined) {
				tasks.push(shard.scratch.hSet('prometheus/user_heap_total_bytes', username, String(heapTotal)));
			}

			if (tasks.length > 0) {
				await Promise.all(tasks);
			}
		}
	}];
});

// 3. processor hooks: Start the process metrics reporter for the processor worker processes
processorHooks.register('workerInitialized', async shard => {
	startProcessMetricsReporter(shard, 'processor');
});

// Helper: Start the process-wide memory reporter once per process
let processReporterStarted = false;
function startProcessMetricsReporter(shard: any, service: 'runner' | 'processor') {
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
				shard.scratch.sAdd('prometheus/active_processes', [key]),
			]);
		} catch (err) {
			console.error(`Failed to report ${service} process memory metrics:`, err);
		}
	};

	reportMemory();
	setInterval(reportMemory, 10000);
}
