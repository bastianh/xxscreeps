export interface AdminApiConfig {
	/**
	 * Administrative API server settings. v1 relies on bind address and firewall policy for access
	 * control.
	 */
	adminApi?: {
		/**
		 * Network interface to bind the admin API server to, or false to disable it. Format is:
		 * "host" or "host:port". Host can be * to bind to all interfaces. Port is 21026 if not
		 * specified.
		 *
		 * Recommended value for local operations: 127.0.0.1:21026
		 * @default false
		 */
		bind?: string | false;
	};
}

export const defaults = {
	adminApi: {
		bind: false,
	},
} satisfies AdminApiConfig;

declare module 'xxscreeps/config/config.js' {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface Config extends AdminApiConfig {}
}
