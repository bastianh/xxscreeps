import type { Shard } from 'xxscreeps/engine/db/index.js';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import { kMaxMemoryLength } from 'xxscreeps/mods/meta/memory/memory.js';

const tickTimeHistogramBucketsMs = [ '1', '2', '5', '10', '20', '50', '100', '200', '500', '1000', '+Inf' ];
const processorPhaseHistogramBucketsMs = [ '1', '2', '5', '10', '20', '50', '100', '200', '500', '1000', '+Inf' ];
const userCpuHistogramBucketsMs = [ '1', '2', '5', '10', '20', '50', '100', '200', '500', '+Inf' ];

interface ProcessMetricsEntry {
	rss: number;
	heapTotal: number;
	heapUsed: number;
	external: number;
	service: string;
	instance: string;
	pid: number;
}

function isProcessMetricsEntry(value: unknown): value is ProcessMetricsEntry {
	return typeof value === 'object' && value !== null && typeof (value as ProcessMetricsEntry).service === 'string';
}

hooks.register('middleware', (koa, router) => {
	// Start the memory reporter for the backend Koa process, lazily on first request
	let reporterStarted = false;
	koa.use(async (context, next): Promise<unknown> => {
		if (!reporterStarted) {
			reporterStarted = true;
			startProcessMetricsReporter(context.shard, 'backend');
		}
		return next();
	});

	// Expose `/metrics`
	router.get('/metrics', async context => {
		const { shard } = context;

		try {
			// Tick / queue / processor-phase gauges
			const [
				tickTimeMs, tickAvgTimeMs, tickGameTime, tickRoomsProcessed, activeRooms, tickActiveUsers,
				processorPhaseMs, processorPhaseTickTime, runnerPhaseMs, runnerPhaseTickTime,
			] = await Promise.all([
				shard.scratch.get('prometheus/tick_time_ms'),
				shard.scratch.get('prometheus/tick_avg_time_ms'),
				shard.scratch.get('prometheus/tick_game_time'),
				shard.scratch.get('prometheus/tick_rooms_processed'),
				shard.scratch.get('prometheus/active_rooms'),
				shard.scratch.get('prometheus/tick_active_users'),
				shard.scratch.get('prometheus/processor_phase_ms'),
				shard.scratch.get('prometheus/processor_phase_tick_time'),
				shard.scratch.get('prometheus/runner_phase_ms'),
				shard.scratch.get('prometheus/runner_phase_tick_time'),
			]);

			// Process memory metrics
			const activeProcessKeys = await shard.scratch.sMembers('prometheus/active_processes');
			const processMetrics: ProcessMetricsEntry[] = [];
			const deadKeys: string[] = [];

			if (activeProcessKeys.length > 0) {
				await Promise.all(
					activeProcessKeys.map(async key => {
						const metricsString = await shard.scratch.get(key);
						if (metricsString === null) {
							deadKeys.push(key);
							return;
						}
						try {
							const parsed: unknown = JSON.parse(metricsString);
							if (isProcessMetricsEntry(parsed)) {
								processMetrics.push(parsed);
							} else {
								deadKeys.push(key);
							}
						} catch {
							deadKeys.push(key);
						}
					}),
				);
			}
			if (deadKeys.length > 0) {
				await shard.scratch.sRem('prometheus/active_processes', deadKeys);
			}

			// Player-specific metrics
			const [
				tickTimeHistogramBuckets, tickTimeHistogramSum, tickTimeHistogramCount,
				processorPhaseHistogramBuckets, processorPhaseHistogramSum, processorPhaseHistogramCount,
				userCpuHistogramBuckets, userCpuTotalMs, userCpuHistogramSum, userCpuHistogramCount,
				userGameMemory, userHeapUsed, userHeapTotal, userVmResets, userLastResetTick, userCodeSize,
			] = await Promise.all([
				shard.scratch.hGetAll('prometheus/tick_time_ms_histogram/bucket'),
				shard.scratch.get('prometheus/tick_time_ms_histogram/sum'),
				shard.scratch.get('prometheus/tick_time_ms_histogram/count'),
				shard.scratch.hGetAll('prometheus/processor_phase_ms_histogram/bucket'),
				shard.scratch.get('prometheus/processor_phase_ms_histogram/sum'),
				shard.scratch.get('prometheus/processor_phase_ms_histogram/count'),
				Promise.all(userCpuHistogramBucketsMs.map(bucket => shard.scratch.hGetAll(`prometheus/user_cpu_tick_ms_histogram/bucket/${bucket}`))),
				shard.scratch.hGetAll('prometheus/user_cpu_total_ms'),
				shard.scratch.hGetAll('prometheus/user_cpu_tick_ms_histogram/sum'),
				shard.scratch.hGetAll('prometheus/user_cpu_tick_ms_histogram/count'),
				shard.scratch.hGetAll('prometheus/user_game_memory_bytes'),
				shard.scratch.hGetAll('prometheus/user_heap_used_bytes'),
				shard.scratch.hGetAll('prometheus/user_heap_total_bytes'),
				shard.scratch.hGetAll('prometheus/user_vm_resets_total'),
				shard.scratch.hGetAll('prometheus/user_last_reset_tick'),
				shard.scratch.hGetAll('prometheus/user_code_size_bytes'),
			]);

			let output = '';
			const heapLimitBytes = config.runner.cpu.memoryLimit * 1024 * 1024;

			const writeMetric = (name: string, type: 'gauge' | 'counter', help: string, values: { labels?: string; value: string | number }[]) => {
				output += `# HELP ${name} ${help}\n`;
				output += `# TYPE ${name} ${type}\n`;
				for (const item of values) {
					output += item.labels === undefined ? `${name} ${item.value}\n` : `${name}{${item.labels}} ${item.value}\n`;
				}
				output += '\n';
			};

			writeMetric('xxscreeps_config_cpu_tick_limit_ms', 'gauge', 'Configured per-user CPU tick limit in milliseconds.', [ { value: config.runner.cpu.tickLimit } ]);
			writeMetric('xxscreeps_config_heap_limit_bytes', 'gauge', 'Configured per-user VM heap limit in bytes.', [ { value: heapLimitBytes } ]);
			writeMetric('xxscreeps_config_raw_memory_limit_bytes', 'gauge', 'Configured per-user RawMemory size limit in bytes.', [ { value: kMaxMemoryLength } ]);

			{
				const values = tickTimeHistogramBucketsMs
					.filter(bucket => tickTimeHistogramBuckets[bucket] !== undefined)
					.map(bucket => ({ labels: `le="${bucket}"`, value: tickTimeHistogramBuckets[bucket]! }));
				if (values.length > 0) {
					writeMetric('xxscreeps_tick_duration_ms_bucket', 'counter', 'Cumulative histogram buckets for game tick execution time in milliseconds. Approximate: measured between successive completed ticks, so it includes any inter-tick pause/delay.', values);
				}
			}
			if (tickTimeHistogramSum !== null) {
				writeMetric('xxscreeps_tick_duration_ms_sum', 'counter', 'Cumulative sum of game tick execution time in milliseconds. Approximate, see xxscreeps_tick_duration_ms_bucket.', [ { value: tickTimeHistogramSum } ]);
			}
			if (tickTimeHistogramCount !== null) {
				writeMetric('xxscreeps_tick_duration_ms_count', 'counter', 'Cumulative count of observed game ticks.', [ { value: tickTimeHistogramCount } ]);
			}

			if (tickTimeMs !== null) {
				writeMetric('xxscreeps_tick_time_ms', 'gauge', 'Approximate wall-clock duration of the most recently completed game tick, including any inter-tick pause/delay.', [ { value: tickTimeMs } ]);
			}
			if (tickAvgTimeMs !== null) {
				writeMetric('xxscreeps_tick_avg_time_ms', 'gauge', 'Rolling average tick duration (see xxscreeps_tick_time_ms for caveats).', [ { value: tickAvgTimeMs } ]);
			}
			if (tickGameTime !== null) {
				writeMetric('xxscreeps_tick_game_time', 'gauge', 'The current game time (tick count).', [ { value: tickGameTime } ]);
			}
			if (tickRoomsProcessed !== null) {
				writeMetric('xxscreeps_tick_rooms_processed', 'gauge', 'Number of rooms in the processor queue for the most recently completed tick.', [ { value: tickRoomsProcessed } ]);
			}
			if (activeRooms !== null) {
				writeMetric('xxscreeps_active_rooms', 'gauge', 'Current number of rooms tracked as active by the processor.', [ { value: activeRooms } ]);
			}
			if (tickActiveUsers !== null) {
				writeMetric('xxscreeps_tick_active_users', 'gauge', 'Number of users in the runner queue for the most recently completed tick.', [ { value: tickActiveUsers } ]);
			}

			// Processor-phase timing (precise: 'process' -> 'tickFinished' span)
			if (processorPhaseMs !== null) {
				writeMetric('xxscreeps_processor_phase_ms', 'gauge', 'Wall-clock duration of the processor phase (room processing + finalize) for the most recently completed tick.', [ { value: processorPhaseMs } ]);
			}
			if (processorPhaseTickTime !== null) {
				writeMetric('xxscreeps_processor_phase_tick_time', 'gauge', 'Game tick that xxscreeps_processor_phase_ms was measured for.', [ { value: processorPhaseTickTime } ]);
			}
			{
				const values = processorPhaseHistogramBucketsMs
					.filter(bucket => processorPhaseHistogramBuckets[bucket] !== undefined)
					.map(bucket => ({ labels: `le="${bucket}"`, value: processorPhaseHistogramBuckets[bucket]! }));
				if (values.length > 0) {
					writeMetric('xxscreeps_processor_phase_duration_ms_bucket', 'counter', 'Cumulative histogram buckets for processor-phase duration in milliseconds.', values);
				}
			}
			if (processorPhaseHistogramSum !== null) {
				writeMetric('xxscreeps_processor_phase_duration_ms_sum', 'counter', 'Cumulative sum of processor-phase duration in milliseconds.', [ { value: processorPhaseHistogramSum } ]);
			}
			if (processorPhaseHistogramCount !== null) {
				writeMetric('xxscreeps_processor_phase_duration_ms_count', 'counter', 'Cumulative count of observed processor phases.', [ { value: processorPhaseHistogramCount } ]);
			}

			// Runner-phase timing (approximate, no histogram: see mod README for caveats)
			if (runnerPhaseMs !== null) {
				writeMetric('xxscreeps_runner_phase_ms', 'gauge', 'Approximate wall-clock span of the runner phase (first player refresh to last player save) for the most recently completed tick. Overlaps the processor phase and is not a precise measurement; see mod README.', [ { value: runnerPhaseMs } ]);
			}
			if (runnerPhaseTickTime !== null) {
				writeMetric('xxscreeps_runner_phase_tick_time', 'gauge', 'Game tick that xxscreeps_runner_phase_ms was measured for.', [ { value: runnerPhaseTickTime } ]);
			}

			// Process memory metrics
			if (processMetrics.length > 0) {
				const rssValues: { labels: string; value: number }[] = [];
				const heapTotalValues: { labels: string; value: number }[] = [];
				const heapUsedValues: { labels: string; value: number }[] = [];
				const externalValues: { labels: string; value: number }[] = [];
				for (const entry of processMetrics) {
					const labels = `service="${entry.service}",instance="${entry.instance}",pid="${entry.pid}"`;
					rssValues.push({ labels: `${labels},type="rss"`, value: entry.rss });
					heapTotalValues.push({ labels: `${labels},type="heapTotal"`, value: entry.heapTotal });
					heapUsedValues.push({ labels: `${labels},type="heapUsed"`, value: entry.heapUsed });
					externalValues.push({ labels: `${labels},type="external"`, value: entry.external });
				}
				writeMetric('xxscreeps_process_memory_bytes', 'gauge', 'Node.js process memory metrics in bytes.',
					[ ...rssValues, ...heapTotalValues, ...heapUsedValues, ...externalValues ]);
			}

			// Per-user metrics
			{
				const values = Object.entries(userCpuTotalMs).map(([ username, value ]) => ({ labels: `username="${username}"`, value: Number(value) / 1000 }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_total_seconds', 'counter', 'Cumulative CPU time spent by player code in seconds.', values);
				}
			}

			const userCpuBucketValues = userCpuHistogramBuckets.flatMap((entries, index) =>
				Object.entries(entries).map(([ username, value ]) => ({ labels: `username="${username}",le="${userCpuHistogramBucketsMs[index]}"`, value })));
			if (userCpuBucketValues.length > 0) {
				writeMetric('xxscreeps_user_cpu_tick_ms_bucket', 'counter', 'Cumulative histogram buckets for per-tick player CPU time in milliseconds.', userCpuBucketValues);
			}
			{
				const values = Object.entries(userCpuHistogramSum).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_tick_ms_sum', 'counter', 'Cumulative sum of per-tick player CPU time in milliseconds.', values);
				}
			}
			{
				const values = Object.entries(userCpuHistogramCount).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_tick_ms_count', 'counter', 'Cumulative count of observed player ticks.', values);
				}
			}
			{
				const values = Object.entries(userGameMemory).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_game_memory_bytes', 'gauge', 'The serialized size of the player\'s Memory object in bytes.', values);
				}
			}
			{
				const values = Object.entries(userHeapUsed).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_heap_used_bytes', 'gauge', 'The player VM isolate heap used space in bytes.', values);
				}
			}
			{
				const values = Object.entries(userHeapTotal).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_heap_total_bytes', 'gauge', 'The player VM isolate heap total allocated space in bytes.', values);
				}
			}
			{
				const values = Object.entries(userVmResets).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_vm_resets_total', 'counter', 'Total number of VM sandbox initializations for the player (includes first start and code-change resets).', values);
				}
			}
			{
				const values = Object.entries(userLastResetTick).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_last_reset_tick', 'gauge', 'Game tick at which the player VM was last initialized or reset. Subtract from xxscreeps_tick_game_time to get ticks since last reset.', values);
				}
			}
			{
				const values = Object.entries(userCodeSize).map(([ username, value ]) => ({ labels: `username="${username}"`, value }));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_code_size_bytes', 'gauge', 'Serialized size of the player code blob in bytes.', values);
				}
			}

			context.type = 'text/plain; version=0.0.4; charset=utf-8';
			context.body = output;
		} catch (err) {
			console.error('Failed to generate Prometheus metrics:', err);
			context.status = 500;
			context.body = 'Internal Server Error';
		}
	});
});

// Helper: start the process-wide memory reporter for the backend Koa process
function startProcessMetricsReporter(shard: Shard, service: 'backend') {
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
