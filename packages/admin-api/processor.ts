import { registerIntentProcessor } from 'xxscreeps/engine/processor/index.js';
import * as C from 'xxscreeps/game/constants/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { checkCreateAdminStructure, createAdminStructure, type AdminStructureType } from './structures.js';

declare module 'xxscreeps/engine/processor/index.js' {
	interface Intent { adminApi: typeof intents }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const intents = [
	registerIntentProcessor(Room, 'adminCreateStructure', { internal: true },
		(room, context, structureType: AdminStructureType, xx: number, yy: number, owner: string | null) => {
			const pos = new RoomPosition(xx, yy, room.name);
			if (checkCreateAdminStructure(room, pos, structureType, owner ?? undefined) === C.OK) {
				room['#insertObject'](createAdminStructure(pos, structureType, owner ?? undefined), true);
				context.didUpdate();
			}
		}),
];
