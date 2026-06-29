declare module 'koa' {
	class Koa<StateT = any, ContextT = any> {
		callback(): (...args: any[]) => unknown;
		use(middleware: Koa.Middleware<StateT, ContextT> | unknown): this;
	}

	namespace Koa {
		type Middleware<StateT = any, ContextT = any> = (context: any, next: () => Promise<unknown>) => unknown;
	}

	export = Koa;
}

declare module 'koa-router' {
	class Router<StateT = any, ContextT = any> {
		constructor(options?: { prefix?: string });
		get(path: string, middleware: Router.Middleware<StateT, ContextT>): this;
		post(path: string, middleware: Router.Middleware<StateT, ContextT>): this;
		put(path: string, middleware: Router.Middleware<StateT, ContextT>): this;
		patch(path: string, middleware: Router.Middleware<StateT, ContextT>): this;
		delete(path: string, middleware: Router.Middleware<StateT, ContextT>): this;
		routes(): unknown;
		allowedMethods(): unknown;
	}

	namespace Router {
		type RouterContext<StateT = any, ContextT = any> = ContextT & {
			body?: unknown;
			params: Record<string, string | undefined>;
			query: Record<string, string | undefined>;
			status?: number;
			url: string;
		};
		type Middleware<StateT = any, ContextT = any> =
			(context: RouterContext<StateT, ContextT>, next: () => Promise<unknown>) => unknown;
	}

	export = Router;
}

declare module 'koa-bodyparser' {
	function bodyParser(options?: { jsonLimit?: string }): any;
	export = bodyParser;
}
