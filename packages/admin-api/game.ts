import type { Shard } from 'xxscreeps/engine/db/index.js';
import { isGamePaused, setGamePaused } from 'xxscreeps/engine/service/control.js';
import { registerAdminRoute } from './routes.js';

export async function getGameStatus(shard: Shard) {
	return {
		ok: 1,
		paused: await isGamePaused(shard),
		tick: shard.time,
	};
}

export async function pauseGame(shard: Shard) {
	await setGamePaused(shard, true);
	await shard.save();
	return {
		ok: 1,
		paused: true,
		tick: shard.time,
	};
}

export async function resumeGame(shard: Shard) {
	await setGamePaused(shard, false);
	await shard.save();
	return {
		ok: 1,
		paused: false,
		tick: shard.time,
	};
}

registerAdminRoute({
	path: '/game',
	execute: context => getGameStatus(context.shard),
});

registerAdminRoute({
	method: 'post',
	path: '/game/pause',
	execute: context => pauseGame(context.shard),
});

registerAdminRoute({
	method: 'post',
	path: '/game/resume',
	execute: context => resumeGame(context.shard),
});
