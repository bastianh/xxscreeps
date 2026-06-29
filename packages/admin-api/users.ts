import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import * as Code from 'xxscreeps/engine/db/user/code.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { kMaxMemorySegmentId } from 'xxscreeps/mods/memory/memory.js';
import * as Memory from 'xxscreeps/mods/memory/model.js';
import { registerAdminRoute } from './routes.js';
import { decodeMemoryBlob, serializeCodeContent } from './inspect.js';

export async function resolveUserId(db: Database, user: string) {
	if (await db.data.sIsMember('users', user)) {
		return user;
	}
	return User.findUserByName(db, user);
}

async function userSummary(db: Database, userId: string) {
	const info = await db.data.hGetAll(User.infoKey(userId));
	return {
		id: userId,
		username: info.username,
		branch: info.branch,
		info,
	};
}

async function loadSegments(shard: Shard, userId: string) {
	const publicSegments = (await shard.data.sMembers(`user/${userId}/publicSegments`))
		.map(Number)
		.filter(id => Number.isInteger(id) && id >= 0 && id < kMaxMemorySegmentId);
	const defaultPublicSegment = await Memory.loadDefaultPublicSegment(shard, userId);
	const ids = [ ...new Set([
		...publicSegments,
		...(defaultPublicSegment === null ? [] : [ defaultPublicSegment ]),
	]) ];
	const segments = await Fn.mapAwait(ids, async id => {
		const blob = await Memory.loadMemorySegmentBlob(shard, userId, id);
		return [ id, blob === null ? null : decodeMemoryBlob(blob) ] as const;
	});
	return {
		defaultPublicSegment,
		publicSegments,
		segments: Object.fromEntries(segments),
		activeForeignSegment: await Memory.loadActiveForeignSegment(shard, userId),
	};
}

async function loadBranches(db: Database, userId: string) {
	const branches = await db.data.sMembers(Code.branchManifestKey(userId));
	const content = await Fn.mapAwait(branches, async branch => {
		const modules = await Code.loadContent(db, userId, branch);
		return [ branch, modules === undefined ? null : serializeCodeContent(modules) ] as const;
	});
	return {
		branches,
		code: Object.fromEntries(content),
	};
}

export async function listUsers(db: Database) {
	const users = await db.data.sMembers('users');
	return {
		ok: 1,
		users: await Fn.mapAwait(users, userId => userSummary(db, userId)),
	};
}

export async function getUserData(db: Database, shard: Shard, user: string) {
	const userId = await resolveUserId(db, user);
	if (userId === null) {
		return { error: 'not found' };
	}
	const [ summary, providers, memoryBlob, segmentData, branchData ] = await Promise.all([
		userSummary(db, userId),
		User.findProvidersForUser(db, userId),
		Memory.loadUserMemoryBlob(shard, userId),
		loadSegments(shard, userId),
		loadBranches(db, userId),
	]);
	return {
		ok: 1,
		...summary,
		providers,
		memory: memoryBlob === null ? null : decodeMemoryBlob(memoryBlob),
		...segmentData,
		...branchData,
	};
}

registerAdminRoute({
	path: '/users',
	execute: context => listUsers(context.db),
});

registerAdminRoute({
	path: '/users/:user',
	execute: context => getUserData(context.db, context.shard, context.params.user ?? ''),
});
