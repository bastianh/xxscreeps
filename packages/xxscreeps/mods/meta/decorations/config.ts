/** One entry of {@link DecorationsSettings.season}. */
export interface SeasonDecoration {
	/**
	 * Id of a decoration the loaded catalog defines.
	 */
	id: string;

	/**
	 * Property values replacing the decoration's own seeds. Checked against the definition the same
	 * way an activation request is; anything the definition does not declare is fatal.
	 */
	props?: Record<string, boolean | number | string>;
}

export interface DecorationsSettings {
	/**
	 * Whether to load the decoration pack bundled with the server.
	 * @default true
	 */
	builtin?: boolean;

	/**
	 * Whether every user owns the whole decoration catalog. With this off, decorations must be
	 * handed out explicitly with `xxscreeps manage decoration grant`.
	 * @default false
	 */
	grantAll?: boolean;

	/**
	 * Whether players have a decoration inventory. With this off the client is never told the
	 * `inventory` feature exists, so it offers neither the inventory section nor the room view's
	 * decorations panel, and the routes which place one are not served. Decorations already placed
	 * are still rendered, and taking one down is still served.
	 * @default false
	 */
	inventory?: boolean;

	/**
	 * Additional decoration packs to load. Each entry is a path to a `pack.yaml`, or to the
	 * directory holding one.
	 */
	packs?: string[];

	/**
	 * Whether placing a decoration requires the player to control or reserve the room.
	 * @default true
	 */
	requireRoomOwnership?: boolean;

	/**
	 * Decorations every room shows by default, the way the official season servers dress the whole
	 * world. Each entry names a decoration from the catalog. They are served after what players
	 * placed, so a player's own placement wins over the season's; the world map never shows them.
	 * Every room-placed type is accepted; `creep` and `badge` are not.
	 * @default []
	 */
	season?: SeasonDecoration[];
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
