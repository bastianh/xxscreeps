import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hooks } from 'xxscreeps/engine/service/symbols.js';
import { activeRoomsKey, processRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { runnerUsersSetKey } from 'xxscreeps/engine/runner/model.js';

const tickTimeHistogramBucketsMs = [ 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000 ];

function recordHistogram(keyBase: string, value: number, buckets: readonly number[], shard: { scratch: any }) {
	const rounded = Math.max(0, Math.round(value));
	const tasks: Promise<any>[] = [
		shard.scratch.incrBy(`${keyBase}/sum`, rounded),
		shard.scratch.incr(`${keyBase}/count`),
		shard.scratch.hincrBy(`${keyBase}/bucket`, '+Inf', 1),
	];
	for (const bucket of buckets) {
		if (rounded <= bucket) {
			tasks.push(shard.scratch.hincrBy(`${keyBase}/bucket`, String(bucket), 1));
		}
	}
	return Promise.all(tasks);
}

hooks.register('beforeTick', async ({ shard, time }) => {
	const [ processedRooms, activeUsers ] = await Promise.all([
		shard.scratch.zCard(processRoomsSetKey(time)),
		shard.scratch.sCard(runnerUsersSetKey(time)),
	]);
	await Promise.all([
		shard.scratch.set('prometheus/tick_rooms_processed', String(processedRooms)),
		shard.scratch.set('prometheus/tick_active_users', String(activeUsers)),
	]);
});

hooks.register('serviceInitialized', shard => {
	const pid = process.pid;
	const instance = `${process.env.HOSTNAME ?? hostname()}:${pid}:t${threadId}`;
	const reportMemory = async () => {
		try {
			const heap = process.memoryUsage();
			const key = `prometheus/process:main:${instance}`;
			await Promise.all([
				shard.scratch.set(key, JSON.stringify({
					rss: heap.rss,
					heapTotal: heap.heapTotal,
					heapUsed: heap.heapUsed,
					external: heap.external,
					service: 'main',
					instance,
					pid,
				}), { px: 30000 }),
				shard.scratch.sAdd('prometheus/active_processes', [ key ]),
			]);
		} catch (err) {
			console.error('Failed to report main service memory metrics:', err);
		}
	};
	reportMemory();
	const interval = setInterval(reportMemory, 10000);
	return () => clearInterval(interval);
});

hooks.register('afterTick', async ({ shard, timeTaken, averageTime }) => {
	const activeRooms = await shard.scratch.zCard(activeRoomsKey);
	await Promise.all([
		shard.scratch.set('prometheus/tick_time_ms', String(timeTaken)),
		shard.scratch.set('prometheus/tick_avg_time_ms', String(averageTime)),
		shard.scratch.set('prometheus/tick_game_time', String(shard.time)),
		shard.scratch.set('prometheus/active_rooms', String(activeRooms)),
		recordHistogram('prometheus/tick_time_ms_histogram', timeTaken, tickTimeHistogramBucketsMs, shard),
	]);
});
