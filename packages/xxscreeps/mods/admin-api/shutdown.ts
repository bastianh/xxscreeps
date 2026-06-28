import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { isGamePaused } from 'xxscreeps/engine/service/control.js';
import { getServiceChannel } from 'xxscreeps/engine/service/index.js';
import { registerAdminRoute } from './routes.js';

function scheduleProcessExit() {
	setTimeout(() => process.exit(0), 100).unref();
}

export async function shutdown(db: Database, shard: Shard, schedule: () => void = scheduleProcessExit) {
	if (!await isGamePaused(shard)) {
		return { error: 'game must be paused' };
	}
	await Promise.all([
		db.save(),
		shard.save(),
		getServiceChannel(shard).publish({ type: 'shutdown' }),
	]);
	schedule();
	return { ok: 1, shuttingDown: true };
}

registerAdminRoute({
	method: 'post',
	path: '/shutdown',
	execute: context => shutdown(context.db, context.shard),
});
