import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import type { Shard } from 'xxscreeps/engine/db/index.js';
import { kMaxMemoryLength } from 'xxscreeps/mods/memory/memory.js';

const tickTimeHistogramBucketsMs = [ '1', '2', '5', '10', '20', '50', '100', '200', '500', '1000', '+Inf' ];
const userCpuHistogramBucketsMs = [ '1', '2', '5', '10', '20', '50', '100', '200', '500', '+Inf' ];

hooks.register('middleware', (koa, router) => {
	// 1. Start the memory reporter for the backend Koa process
	let reporterStarted = false;
	koa.use(async (context, next) => {
		if (!reporterStarted && context.shard) {
			reporterStarted = true;
			startProcessMetricsReporter(context.shard, 'backend');
		}
		return next();
	});

	// 2. Expose `/metrics` endpoint
	router.get('/metrics', async (context) => {
		const { shard } = context;
		if (!shard) {
			context.status = 500;
			context.body = 'Shard not connected';
			return;
		}

		try {
			// Retrieve tick stats
			const [tickTimeMs, tickAvgTimeMs, tickGameTime, tickRoomsProcessed, activeRooms, tickActiveUsers] = await Promise.all([
				shard.scratch.get('prometheus/tick_time_ms'),
				shard.scratch.get('prometheus/tick_avg_time_ms'),
				shard.scratch.get('prometheus/tick_game_time'),
				shard.scratch.get('prometheus/tick_rooms_processed'),
				shard.scratch.get('prometheus/active_rooms'),
				shard.scratch.get('prometheus/tick_active_users'),
			]);

			// Retrieve process memory metrics
			const activeProcessKeys = await shard.scratch.sMembers('prometheus/active_processes');
			const processMetrics: Record<string, any>[] = [];
			const deadKeys: string[] = [];

			if (activeProcessKeys.length > 0) {
				await Promise.all(
					activeProcessKeys.map(async (key) => {
						const metricsString = await shard.scratch.get(key);
						if (metricsString) {
							try {
								const metrics = JSON.parse(metricsString);
								if (metrics && metrics.service) {
									processMetrics.push(metrics);
								} else {
									deadKeys.push(key);
								}
							} catch (err) {
								deadKeys.push(key);
							}
						} else {
							deadKeys.push(key);
						}
					})
				);
			}

			// Cleanup expired process keys
			if (deadKeys.length > 0) {
				await shard.scratch.sRem('prometheus/active_processes', deadKeys);
			}

			// Retrieve player-specific metrics
			const [
				tickTimeHistogramBuckets,
				tickTimeHistogramSum,
				tickTimeHistogramCount,
				userCpuHistogramBuckets,
				userCpuTotalMs,
				userCpuHistogramSum,
				userCpuHistogramCount,
				userGameMemory,
				userHeapUsed,
				userHeapTotal,
				userVmResets,
				userLastResetTick,
				userCodeSize,
			] = await Promise.all([
				shard.scratch.hGetAll('prometheus/tick_time_ms_histogram/bucket'),
				shard.scratch.get('prometheus/tick_time_ms_histogram/sum'),
				shard.scratch.get('prometheus/tick_time_ms_histogram/count'),
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

			// Build metrics exposition string
			let output = '';
			const heapLimitBytes = config.runner.cpu.memoryLimit * 1024 * 1024;

			// Helper to write formatted metric
			const writeMetric = (name: string, type: 'gauge' | 'counter', help: string, values: { labels?: string; value: string | number }[]) => {
				output += `# HELP ${name} ${help}\n`;
				output += `# TYPE ${name} ${type}\n`;
				for (const item of values) {
					if (item.labels) {
						output += `${name}{${item.labels}} ${item.value}\n`;
					} else {
						output += `${name} ${item.value}\n`;
					}
				}
				output += '\n';
			};

			writeMetric('xxscreeps_config_cpu_tick_limit_ms', 'gauge', 'Configured per-user CPU tick limit in milliseconds.', [{ value: config.runner.cpu.tickLimit }]);
			writeMetric('xxscreeps_config_heap_limit_bytes', 'gauge', 'Configured per-user VM heap limit in bytes.', [{ value: heapLimitBytes }]);
			writeMetric('xxscreeps_config_raw_memory_limit_bytes', 'gauge', 'Configured per-user RawMemory size limit in bytes.', [{ value: kMaxMemoryLength }]);

			if (tickTimeHistogramBuckets) {
				writeMetric('xxscreeps_tick_duration_ms_bucket', 'counter', 'Cumulative histogram buckets for game tick execution time in milliseconds.',
					tickTimeHistogramBucketsMs
						.filter(bucket => tickTimeHistogramBuckets[bucket] !== undefined)
						.map(bucket => ({ labels: `le="${bucket}"`, value: tickTimeHistogramBuckets[bucket]! })));
			}
			if (tickTimeHistogramSum !== null) {
				writeMetric('xxscreeps_tick_duration_ms_sum', 'counter', 'Cumulative sum of game tick execution time in milliseconds.', [{ value: tickTimeHistogramSum }]);
			}
			if (tickTimeHistogramCount !== null) {
				writeMetric('xxscreeps_tick_duration_ms_count', 'counter', 'Cumulative count of observed game ticks.', [{ value: tickTimeHistogramCount }]);
			}

			// Write tick metrics
			if (tickTimeMs !== null) {
				writeMetric('xxscreeps_tick_time_ms', 'gauge', 'The execution time of the last game tick in milliseconds.', [{ value: tickTimeMs }]);
			}
			if (tickAvgTimeMs !== null) {
				writeMetric('xxscreeps_tick_avg_time_ms', 'gauge', 'The 100-tick rolling average execution time in milliseconds.', [{ value: tickAvgTimeMs }]);
			}
			if (tickGameTime !== null) {
				writeMetric('xxscreeps_tick_game_time', 'gauge', 'The current game time (tick count).', [{ value: tickGameTime }]);
			}
			if (tickRoomsProcessed !== null) {
				writeMetric('xxscreeps_tick_rooms_processed', 'gauge', 'Number of rooms that were in the processor queue for the completed tick.', [{ value: tickRoomsProcessed }]);
			}
			if (activeRooms !== null) {
				writeMetric('xxscreeps_active_rooms', 'gauge', 'Number of rooms currently tracked as active by the processor.', [{ value: activeRooms }]);
			}
			if (tickActiveUsers !== null) {
				writeMetric('xxscreeps_tick_active_users', 'gauge', 'Number of users scheduled in the runner queue for the completed tick.', [{ value: tickActiveUsers }]);
			}

			// Write process memory metrics
			if (processMetrics.length > 0) {
				const rssValues: any[] = [];
				const heapTotalValues: any[] = [];
				const heapUsedValues: any[] = [];
				const externalValues: any[] = [];

				for (const p of processMetrics) {
					const labels = `service="${p.service}",instance="${p.instance ?? p.pid}",pid="${p.pid}"`;
					if (p.rss !== undefined) rssValues.push({ labels: `${labels},type="rss"`, value: p.rss });
					if (p.heapTotal !== undefined) heapTotalValues.push({ labels: `${labels},type="heapTotal"`, value: p.heapTotal });
					if (p.heapUsed !== undefined) heapUsedValues.push({ labels: `${labels},type="heapUsed"`, value: p.heapUsed });
					if (p.external !== undefined) externalValues.push({ labels: `${labels},type="external"`, value: p.external });
				}

				const allProcessValues = [...rssValues, ...heapTotalValues, ...heapUsedValues, ...externalValues];
				if (allProcessValues.length > 0) {
					writeMetric('xxscreeps_process_memory_bytes', 'gauge', 'Node.js process memory metrics in bytes.', allProcessValues);
				}
			}

			// Write user CPU totals
			if (userCpuTotalMs) {
				const values = Object.entries(userCpuTotalMs).map(([username, value]) => ({
					labels: `username="${username}"`,
					value: Number(value) / 1000,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_total_seconds', 'counter', 'Cumulative CPU time spent by player code in seconds.', values);
				}
			}

			const userCpuBucketValues = userCpuHistogramBuckets.flatMap((entries, index) =>
				Object.entries(entries).map(([username, value]) => ({
					labels: `username="${username}",le="${userCpuHistogramBucketsMs[index]}"`,
					value,
				})));
			if (userCpuBucketValues.length > 0) {
				writeMetric('xxscreeps_user_cpu_tick_ms_bucket', 'counter', 'Cumulative histogram buckets for per-tick player CPU time in milliseconds.', userCpuBucketValues);
			}
			if (userCpuHistogramSum) {
				const values = Object.entries(userCpuHistogramSum).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_tick_ms_sum', 'counter', 'Cumulative sum of per-tick player CPU time in milliseconds.', values);
				}
			}
			if (userCpuHistogramCount) {
				const values = Object.entries(userCpuHistogramCount).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_cpu_tick_ms_count', 'counter', 'Cumulative count of observed player ticks.', values);
				}
			}

			// Write user game memory sizes
			if (userGameMemory) {
				const values = Object.entries(userGameMemory).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_game_memory_bytes', 'gauge', 'The serialized size of the player\'s Memory object in bytes.', values);
				}
			}

			// Write user isolate VM heap used
			if (userHeapUsed) {
				const values = Object.entries(userHeapUsed).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_heap_used_bytes', 'gauge', 'The player VM isolate heap used space in bytes.', values);
				}
			}

			// Write user isolate VM heap total allocated
			if (userHeapTotal) {
				const values = Object.entries(userHeapTotal).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_heap_total_bytes', 'gauge', 'The player VM isolate heap total allocated space in bytes.', values);
				}
			}

			// Write user VM reset counters
			if (userVmResets) {
				const values = Object.entries(userVmResets).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_vm_resets_total', 'counter', 'Total number of VM sandbox initializations for the player (includes first start and code-change resets).', values);
				}
			}

			// Write game tick at which each player's VM was last reset
			if (userLastResetTick) {
				const values = Object.entries(userLastResetTick).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
				if (values.length > 0) {
					writeMetric('xxscreeps_user_last_reset_tick', 'gauge', 'Game tick at which the player VM was last initialized or reset. Subtract from xxscreeps_tick_game_time to get ticks since last reset.', values);
				}
			}

			// Write user code blob sizes
			if (userCodeSize) {
				const values = Object.entries(userCodeSize).map(([username, value]) => ({
					labels: `username="${username}"`,
					value,
				}));
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

// Helper: Start the process-wide memory reporter for the backend process
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
				shard.scratch.sAdd('prometheus/active_processes', [key]),
			]);
		} catch (err) {
			console.error(`Failed to report ${service} process memory metrics:`, err);
		}
	};

	reportMemory();
	setInterval(reportMemory, 10000);
}
