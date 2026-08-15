import type { Shard } from 'xxscreeps/engine/db/index.js';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { registerShardInitializer, registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { activeRoomsKey, getProcessorChannel, processRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { runnerUsersSetKey } from 'xxscreeps/engine/runner/model.js';
import { getServiceChannel } from 'xxscreeps/engine/service/index.js';
import { AveragingTimer } from 'xxscreeps/utility/averaging-timer.js';

const tickTimeHistogramBucketsMs = [ 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000 ];
const processorPhaseHistogramBucketsMs = [ 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000 ];

function recordHistogram(keyBase: string, value: number, buckets: readonly number[], shard: Shard) {
	const rounded = Math.max(0, Math.round(value));
	const tasks: Promise<unknown>[] = [
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

// Helper: start the process-wide memory reporter for a given service, once per process.
function startProcessMetricsReporter(shard: Shard, service: 'main') {
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

// Tick timing (approximate): this engine version has no hook that carries the exact tick duration
// measured by `engine/service/main.ts`'s own loop, and that value isn't published anywhere a mod
// can read it. The nearest observable boundary is one `registerShardTickProcessor` call per
// completed tick, so this times the gap between successive calls -- which also folds in the
// inter-tick pause/delay that the core's own measurement excludes.
const tickTimer = new AveragingTimer(100);
let lastTickFinishedAt: number | undefined;

registerShardTickProcessor(async (shard, time) => {
	const now = Date.now();
	const hadPrevious = lastTickFinishedAt !== undefined;
	const timeTaken = hadPrevious ? now - lastTickFinishedAt! : 0;
	const averageTime = hadPrevious ? Math.floor(tickTimer.stop() / 10000) / 100 : 0;
	lastTickFinishedAt = now;
	tickTimer.start();

	const [ processedRooms, activeUsers, activeRooms ] = await Promise.all([
		shard.scratch.zCard(processRoomsSetKey(time)),
		shard.scratch.sCard(runnerUsersSetKey(time)),
		shard.scratch.zCard(activeRoomsKey),
	]);

	const tasks: Promise<unknown>[] = [
		shard.scratch.set('prometheus/tick_game_time', String(time)),
		shard.scratch.set('prometheus/tick_rooms_processed', String(processedRooms)),
		shard.scratch.set('prometheus/tick_active_users', String(activeUsers)),
		shard.scratch.set('prometheus/active_rooms', String(activeRooms)),
	];
	if (hadPrevious) {
		tasks.push(
			shard.scratch.set('prometheus/tick_time_ms', String(timeTaken)),
			shard.scratch.set('prometheus/tick_avg_time_ms', String(averageTime)),
			recordHistogram('prometheus/tick_time_ms_histogram', timeTaken, tickTimeHistogramBucketsMs, shard),
		);
	}
	await Promise.all(tasks);
});

registerShardInitializer(async shard => {
	startProcessMetricsReporter(shard, 'main');

	// Processor-phase timing (precise): the 'process' -> 'tickFinished' span on these channels is
	// exactly the boundary `engine/service/main.ts` itself waits on, so unlike the tick-wall-clock
	// approximation above this one matches the real processor (process + finalize) duration.
	const [ processorSubscription, serviceSubscription ] = await Promise.all([
		getProcessorChannel(shard).subscribe(),
		getServiceChannel(shard).subscribe(),
	]);

	let phaseStartedAt: number | undefined;
	let phaseTime: number | undefined;
	processorSubscription.listen(message => {
		if (message.type === 'process') {
			phaseStartedAt = Date.now();
			phaseTime = message.time;
		}
	});
	serviceSubscription.listen(message => {
		if (message.type === 'tickFinished' && phaseStartedAt !== undefined && message.time === phaseTime) {
			const duration = Date.now() - phaseStartedAt;
			phaseStartedAt = undefined;
			Promise.all([
				shard.scratch.set('prometheus/processor_phase_ms', String(duration)),
				shard.scratch.set('prometheus/processor_phase_tick_time', String(message.time)),
				recordHistogram('prometheus/processor_phase_ms_histogram', duration, processorPhaseHistogramBucketsMs, shard),
			]).catch(err => console.error('Failed to report processor phase metrics:', err));
		}
	});
});
