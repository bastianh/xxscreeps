import type { Manifest } from 'xxscreeps/config/mods.js';

export const manifest: Manifest = {
	dependencies: [
		'xxscreeps/mods/construction',
		'xxscreeps/mods/controller',
		'xxscreeps/mods/defense',
		'xxscreeps/mods/memory',
		'xxscreeps/mods/road',
		'xxscreeps/mods/structure',
	],
	provides: [ 'backend', 'config', 'processor', 'test' ],
};
