export interface DecorationsSettings {
	/**
	 * Absolute base url of decoration assets, e.g. "https://screeps.example.com". Only needed when
	 * the client is served from a different origin than the backend; by default assets are
	 * referenced relative to the document, which is what lets a proxy serve the client under a path
	 * prefix.
	 */
	assetBaseUrl?: string;

	/**
	 * Whether to load the decoration pack bundled with the server.
	 * @default true
	 */
	builtin?: boolean;

	/**
	 * Whether every user owns the whole decoration catalog. With this off, decorations must be
	 * handed out explicitly with `xxscreeps manage decoration grant`.
	 * @default true
	 */
	grantAll?: boolean;

	/**
	 * Additional decoration packs to load. Each entry is a path to a `pack.json`, or to the
	 * directory holding one.
	 */
	packs?: string[];

	/**
	 * Whether placing a decoration requires the player to control or reserve the room.
	 * @default true
	 */
	requireRoomOwnership?: boolean;
}

export interface DecorationsConfig {
	/**
	 * Room decoration settings
	 */
	decorations?: DecorationsSettings;
}

declare module 'xxscreeps/config/config.js' {
	interface Config extends DecorationsConfig {}
}
