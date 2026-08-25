import { hooks } from 'xxscreeps/backend/index.js';

hooks.register('route', {
	path: '/api/game/world-size',
	execute(context) {
		const size = context.world.map.getWorldSize();
		return {
			ok: 1,
			width: size,
			height: size,
		};
	},
});
