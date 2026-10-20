import type { Context, State } from 'xxscreeps:backend';
import * as http from 'node:http';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import ConditionalGet from 'koa-conditional-get';
import Router from 'koa-router';
import { config } from 'xxscreeps/config/index.js';
import { handleInterruptSignal } from 'xxscreeps/engine/service/signal.js';
import { initializeGameEnvironment } from 'xxscreeps/game/index.js';
import { authentication } from './auth/index.js';
import { BackendContext } from './context.js';
import { installEndpointHandlers } from './endpoints/index.js';
import { setupGracefulShutdown } from './graceful.js';
import { installSocketHandlers, installUpgradeHandlers } from './socket.js';
import { hooks } from './symbols.js';
import 'xxscreeps:mods/backend';
import 'xxscreeps:mods/game';
import 'xxscreeps:mods/processor';

/**
 * The shard a request addressed, or `undefined` when it didn't name one. The client passes it as a
 * query parameter on reads and inside the payload on writes.
 */
function shardNameForRequest(context: Koa.ParameterizedContext<State, Context>) {
	const query = context.query.shard;
	if (typeof query === 'string') {
		return query;
	}
	const body: unknown = context.request.body;
	if (typeof body === 'object' && body !== null && 'shard' in body && typeof body.shard === 'string') {
		return body.shard;
	}
}

initializeGameEnvironment();

// Initialize services
await using backendContext = await BackendContext.connect();
// nb: Fires once per shard. Anything a mod sets up here is per-shard state.
const backendReady = hooks.makeIterated('backendReady');
for (const { shard } of backendContext.shards.values()) {
	backendReady(backendContext.db, shard);
}
const koa = new Koa<State, Context>();
const router = new Router<State, Context>();

// Reverse proxy configuration
const { proxy } = config.backend;
if (proxy) {
	const { forwardedCount } = proxy;
	koa.proxy = true;
	koa.maxIpsCount = proxy.forwardedCount;
	koa.use((ctx, next) => {
		if (ctx.ips.length === forwardedCount) {
			return next();
		} else {
			console.error('forwardedCount mismatch', { expected: forwardedCount, received: ctx.ips.length });
			ctx.status = 500;
		}
	});
}

// Set up endpoints
const httpServer = http.createServer(function() {
	const callback = koa.callback();
	return (req, res) => void callback(req, res);
}());
const unlistenServer = setupGracefulShutdown(httpServer);
installUpgradeHandlers(koa, httpServer);
const socketHandler = installSocketHandlers(koa, backendContext);
koa.use(ConditionalGet());
koa.use(async (context, next) => {
	try {
		await next();
	} catch (err) {
		console.error(`Unhandled error. Endpoint: ${context.url}\n`, err);
		context.status = 500;
		context.body = '';
	}
});
koa.use((context, next) => {
	context.backend = backendContext;
	context.db = backendContext.db;
	return next();
});
koa.use(bodyParser({
	jsonLimit: '8mb',
}));
// Resolve the shard this request addressed. Runs after `bodyParser` because a POST names its shard
// in the body, where the client puts it for `console`, `memory`, `map-stats` and friends.
koa.use((context, next) => {
	const name = shardNameForRequest(context);
	const shard = backendContext.findShard(name);
	if (shard === undefined) {
		context.status = 400;
		context.body = { error: `Unknown shard: ${name!}` };
		return;
	}
	context.shard = shard.shard;
	context.world = shard.world;
	context.accessibleRooms = shard.accessibleRooms;
	return next();
});
koa.use(authentication());
hooks.makeIterated('middleware')(koa, router);
koa.use(router.routes());
koa.use(router.allowedMethods());
installEndpointHandlers(koa, router);

// Read configuration
const addr = function(): [ number ] {
	const [ addr, portString ] = config.backend.bind.split(':');
	const port = Number(portString ?? 21025);
	if (addr === '*') {
		return [ port ];
	} else {
		return [ port, addr ] as unknown as [ number ];
	}
}();
httpServer.listen(...addr, () => console.log('🌎 Listening'));

// Interrupt handler
const halt: PromiseWithResolvers<void> = Promise.withResolvers();
using _signal = handleInterruptSignal(halt.resolve);
await halt.promise;

// Start graceful exit
await unlistenServer();
await socketHandler.flush();
