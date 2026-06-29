import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import type Router from 'koa-router';
import * as http from 'node:http';
import KoaApplication from 'koa';
import bodyParser from 'koa-bodyparser';
import KoaRouter from 'koa-router';
import { hooks } from 'xxscreeps/backend/index.js';
import { setupGracefulShutdown } from 'xxscreeps/backend/graceful.js';
import { config } from 'xxscreeps/config/index.js';
import { routes } from './routes.js';
import './game.js';
import './room-structures.js';
import './shutdown.js';
import './store.js';
import './terrain.js';
import './users.js';

interface AdminContext {
	db: Database;
	shard: Shard;
	request: {
		body?: unknown;
	};
}

type AdminState = object;
type AdminRouterContext = Router.RouterContext<AdminState, AdminContext>;

function parseBind(bind: string) {
	const [ host, rawPort ] = bind.split(':');
	const port = Number(rawPort ?? 21026);
	if (host === '*') {
		return { host: undefined, port };
	}
	return { host, port };
}

let unlistenServer: (() => Promise<void> | void) | undefined;

hooks.register('backendReady', (db, shard) => {
	const bind = config.adminApi?.bind ?? false;
	if (bind === false) {
		return;
	}

	const koa = new KoaApplication<AdminState, AdminContext>();
	const router = new KoaRouter<AdminState, AdminContext>({
		prefix: '/admin',
	});
	const server = http.createServer(koa.callback());
	unlistenServer = setupGracefulShutdown(server);

	koa.use(async (context: AdminRouterContext, next: () => Promise<unknown>) => {
		try {
			await next();
		} catch (err) {
			console.error(`Unhandled admin API error. Endpoint: ${context.url}\n`, err);
			context.status = 500;
			context.body = { error: 'internal' };
		}
	});
	koa.use((context: AdminRouterContext, next: () => Promise<unknown>) => {
		context.db = db;
		context.shard = shard;
		return next();
	});
	koa.use(bodyParser({
		jsonLimit: '8mb',
	}));

	for (const route of routes) {
			router[route.method ?? 'get'](route.path, async (context: AdminRouterContext, next: () => Promise<unknown>) => {
			const value = await route.execute(context as AdminRouterContext);
			if (value === undefined) {
				return next();
			}
			context.body = value;
		});
	}
	koa.use(router.routes());
	koa.use(router.allowedMethods());

	const { host, port } = parseBind(bind);
	server.listen(port, host, () => console.log('🔧 Admin API listening'));
});

hooks.register('backendShutdown', async () => {
	await unlistenServer?.();
});
