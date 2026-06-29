import type Router from 'koa-router';
import type { Database, Shard } from 'xxscreeps/engine/db/index.js';

interface AdminContext {
	db: Database;
	shard: Shard;
	request: {
		body?: unknown;
	};
}

type AdminState = object;
type AdminMethod = 'delete' | 'get' | 'patch' | 'post' | 'put';
type AdminRouterContext = Router.RouterContext<AdminState, AdminContext>;

export interface AdminRoute {
	method?: AdminMethod;
	path: string;
	execute(context: AdminRouterContext): unknown;
}

export const routes: AdminRoute[] = [];

export function registerAdminRoute(route: AdminRoute) {
	routes.push(route);
}
