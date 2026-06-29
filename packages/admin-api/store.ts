import { registerAdminRoute } from './routes.js';
import { queryNumber, readBlob, requiredString, selectStore } from './inspect.js';

function getKey(query: Record<string, unknown>) {
	return requiredString(query.key);
}

registerAdminRoute({
	path: '/store/:store/string',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		return { ok: 1, store: context.params.store, type: 'string', key, value: await store.get(key) };
	},
});

registerAdminRoute({
	path: '/store/:store/blob',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		return { ok: 1, store: context.params.store, type: 'blob', key, value: await readBlob(store, key) };
	},
});

registerAdminRoute({
	path: '/store/:store/hash',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		return { ok: 1, store: context.params.store, type: 'hash', key, value: await store.hGetAll(key) };
	},
});

registerAdminRoute({
	path: '/store/:store/list',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		const start = queryNumber(context.query.start, 0);
		const stop = queryNumber(context.query.stop, -1);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		if (start === undefined || stop === undefined) return { error: 'invalid range' };
		return { ok: 1, store: context.params.store, type: 'list', key, value: await store.lRange(key, start, stop) };
	},
});

registerAdminRoute({
	path: '/store/:store/set',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		return { ok: 1, store: context.params.store, type: 'set', key, value: await store.sMembers(key) };
	},
});

registerAdminRoute({
	path: '/store/:store/zset',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		const start = queryNumber(context.query.start, 0);
		const stop = queryNumber(context.query.stop, -1);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		if (start === undefined || stop === undefined) return { error: 'invalid range' };
		return { ok: 1, store: context.params.store, type: 'zset', key, value: await store.zRangeWithScores(key, start, stop) };
	},
});

registerAdminRoute({
	path: '/store/:store/ttl',
	execute: async context => {
		const store = selectStore(context.db, context.shard, context.params.store ?? '');
		const key = getKey(context.query);
		if (!store) return { error: 'invalid store' };
		if (!key) return { error: 'invalid key' };
		return { ok: 1, store: context.params.store, type: 'ttl', key, value: await store.pTTL(key) };
	},
});
