import type { RoomPosition } from 'xxscreeps/game/position.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import type { ConstructionSite } from 'xxscreeps/mods/construction/construction-site.js';
import type { ConstructibleStructureType } from 'xxscreeps/mods/construction/construction-site.js';
import { asUnion } from 'xxscreeps/utility/utility.js';
import * as C from 'xxscreeps/game/constants/index.js';
import { LOOK_CONSTRUCTION_SITES } from 'xxscreeps/mods/construction/constants.js';
import { Structure } from 'xxscreeps/mods/structure/structure.js';
import { LOOK_STRUCTURES } from 'xxscreeps/mods/structure/constants.js';
import { structureFactories } from 'xxscreeps/mods/construction/symbols.js';
import { CONTROLLER_STRUCTURES } from 'xxscreeps/mods/controller/constants.js';
import { STRUCTURE_RAMPART, STRUCTURE_WALL } from 'xxscreeps/mods/defense/constants.js';
import { create as createRampart } from 'xxscreeps/mods/defense/rampart.js';
import { create as createWall } from 'xxscreeps/mods/defense/wall.js';
import { STRUCTURE_ROAD } from 'xxscreeps/mods/road/constants.js';
import { create as createRoad } from 'xxscreeps/mods/road/road.js';

export const adminStructureTypes = [
	STRUCTURE_ROAD,
	STRUCTURE_RAMPART,
	STRUCTURE_WALL,
] as const;

export type AdminStructureType = typeof adminStructureTypes[number];

type AdminStructureSpec = {
	ownable: boolean;
	create(pos: RoomPosition, owner?: string): any;
};

const adminStructureSpecs = new Map<AdminStructureType, AdminStructureSpec>([
	[STRUCTURE_ROAD, {
		ownable: false,
		create: pos => createRoad(pos),
	}],
	[STRUCTURE_RAMPART, {
		ownable: true,
		create: (pos, owner) => createRampart(pos, owner!),
	}],
	[STRUCTURE_WALL, {
		ownable: false,
		create: pos => createWall(pos),
	}],
]);

export function isAdminStructureType(value: string): value is AdminStructureType {
	return adminStructureSpecs.has(value as AdminStructureType);
}

function getAdminStructureSpec(structureType: AdminStructureType) {
	return adminStructureSpecs.get(structureType)!;
}

export function checkCreateAdminStructure(
	room: Room,
	pos: RoomPosition,
	structureType: AdminStructureType,
	owner: string | undefined,
) {
	const spec = getAdminStructureSpec(structureType);
	if (spec.ownable) {
		if (owner === undefined) {
			return C.ERR_INVALID_ARGS;
		}
		if (room.controller?.['#user'] !== owner) {
			return C.ERR_NOT_OWNER;
		}
	} else if (owner !== undefined) {
		return C.ERR_INVALID_ARGS;
	}

	const controllerLimit = CONTROLLER_STRUCTURES[structureType][room.controller?.level ?? 0];
	const structures = room['#lookFor'](LOOK_STRUCTURES as never) as unknown as Structure[];
	const constructionSites = room['#lookFor'](LOOK_CONSTRUCTION_SITES as never) as unknown as ConstructionSite[];
	const existingCount =
		structures.filter(object => object.structureType === structureType).length +
		constructionSites.filter(object => object.structureType === structureType).length;
	if (existingCount >= (controllerLimit ?? 0)) {
		return C.ERR_RCL_NOT_ENOUGH;
	}

	const factory = structureFactories.get(structureType as string);
	if (!factory || factory.checkPlacement(room, pos) === null) {
		return C.ERR_INVALID_TARGET;
	}

	for (const object of room['#lookAt'](pos)) {
		asUnion(object);
		if (object['#lookType'] === LOOK_CONSTRUCTION_SITES) {
			return C.ERR_INVALID_TARGET;
		}
		if (object instanceof Structure) {
			if (object.structureType === structureType) {
				return C.ERR_INVALID_TARGET;
			}
			const existing = structureFactories.get(object.structureType as string);
			if (!factory.stackable && !existing?.stackable) {
				return C.ERR_INVALID_TARGET;
			}
		}
	}

	return C.OK;
}

export function createAdminStructure(
	pos: RoomPosition,
	structureType: AdminStructureType,
	owner: string | undefined,
) {
	return getAdminStructureSpec(structureType).create(pos, owner);
}
