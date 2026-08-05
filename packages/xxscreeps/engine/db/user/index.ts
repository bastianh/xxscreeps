import type { Badge } from './badge.js';
import type { Database } from 'xxscreeps/engine/db/index.js';
import type { MaybePromise } from 'xxscreeps/utility/types.js';
import { config } from 'xxscreeps/config/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { makeHookRegistration } from 'xxscreeps/utility/hook.js';
import { branchManifestKey, buffersKey, saveContent, stringsKey } from './code.js';

// Lifecycle hooks for users. Mods register `remove` handlers to tear down their own per-user,
// db-scoped state (e.g. private messages, stats) when a user is deleted, so `remove` below stays
// self-contained for every caller rather than each call site enumerating mod cleanups.
//
// `verifyEmail` fires when an address has been stored *pending* and needs out-of-band confirmation
// (see `setEmail`). A mod registers a handler to send the user a verification link; that any handler
// is registered is also how `setEmail` knows a verifier exists and email gating is possible. The
// hook is awaited, so slow/fallible work (sending mail) must be backgrounded with its own error
// handling rather than block or fail the registration that triggered it.
export const hooks = makeHookRegistration<{
	remove: (db: Database, userId: string) => MaybePromise<void>;
	verifyEmail: (db: Database, userId: string, email: string) => MaybePromise<void>;
}>();
const removeHooks = hooks.makeMapped('remove');

const providerMembersKey = (provider: string) => `usersByProvider/${provider}`;
const userProvidersKey = (userId: string) => `user/${userId}/provider`;
export const infoKey = (userId: string) => `user/${userId}`;

// Field on the user info hash holding an address awaiting confirmation. Distinct from the `email`
// provider, which only ever holds a *confirmed* address.
const pendingEmailField = 'pendingEmail';

interface BackendUserInfo {
	username: string;
	badge: Badge | null;
}

const annoyingUsernames = [
	NaN, Infinity, false, true, undefined, null,
].map(value => `${value}`);
export function checkUsername(username: string) {
	return (
		typeof username === 'string' &&
		username.length <= 20 &&
		!annoyingUsernames.includes(username) &&
		/^[a-zA-Z0-9][a-zA-Z0-9_-]+[a-zA-Z0-9]$/.test(username)
	);
}

function flattenUsername(username: string) {
	return username.replace(/[-_ ]/g, '').toLowerCase();
}

export async function create(db: Database, userId: string, username: string, providers: { provider: string; id: string }[] = []) {
	// TODO: multi / exec

	// An `email` provider is established separately at the end — it may be held pending confirmation
	// rather than associated outright — so keep it out of the inline associations. Everything else
	// (username, steam, discord, ...) is associated directly.
	const emailProvider = providers.find(({ provider }) => provider === 'email');
	const directProviders = [
		{ provider: 'username', id: flattenUsername(username) },
		...providers.filter(({ provider }) => provider !== 'email'),
	];

	// Check for existing associations. The email is checked here too (against confirmed providers) so
	// registration fails early when the address is already actively taken.
	const conflictChecks = emailProvider ? [ ...directProviders, emailProvider ] : directProviders;
	const providerConflicts = await Promise.all(Fn.map(conflictChecks,
		({ provider, id }) => db.data.hGet(providerMembersKey(provider), id)));
	if (Fn.some(providerConflicts, value => value !== null)) {
		throw new Error('Already associated');
	}

	// Make user
	const key = infoKey(userId);
	const result = await db.data.hSet(key, 'username', username, { if: 'NX' });
	if (!result) {
		throw new Error('User already created');
	}
	await Promise.all<any>([
		db.data.sAdd('users', [ userId ]),
		db.data.hmSet(key, {
			registeredDate: Date.now(),
		}),
		db.data.hmSet(userProvidersKey(userId),
			[ ...Fn.map(directProviders, ({ provider, id }): [ string, string ] => [ provider, id ]) ]),
		...Fn.map(directProviders, ({ provider, id }) =>
			db.data.hSet(providerMembersKey(provider), id, userId)),
	]);

	await saveContent(db, userId, 'main', new Map([ [ 'main', 'module.exports.loop = function () {};' ] ]));

	// Establish the email last, now that the user exists: this decides auto-verify vs. pending and,
	// when pending, kicks off confirmation via the `verifyEmail` hook.
	if (emailProvider) {
		await setEmail(db, userId, emailProvider.id);
	}
}

/**
 * Associate `email` as the user's confirmed `email` provider, replacing any address they had before.
 * Returns `false` without writing when the address is already the confirmed provider of a *different*
 * user; storage failures propagate.
 */
async function associateEmail(db: Database, userId: string, email: string) {
	const [ existing, previous ] = await Promise.all([
		db.data.hGet(providerMembersKey('email'), email),
		db.data.hGet(userProvidersKey(userId), 'email'),
	]);
	if (existing !== null && existing !== userId) {
		return false;
	}
	await Promise.all([
		db.data.hSet(userProvidersKey(userId), 'email', email),
		db.data.hSet(providerMembersKey('email'), email, userId),
		// Free the reverse lookup for a replaced address so it can be reused.
		...previous !== null && previous !== email ? [ db.data.hDel(providerMembersKey('email'), [ previous ]) ] : [],
	]);
	return true;
}

/**
 * Establish `email` for a user, either confirming it immediately or holding it pending out-of-band
 * verification. Called at registration and when a user changes their address; returns whether the
 * address was left pending.
 *
 * Gating is opt-in: an address is held pending only when `backend.autoVerifyEmail` is explicitly
 * `false` *and* a `verifyEmail` handler (i.e. an email-verification mod) is installed to confirm it.
 * Otherwise — the default, or when no verifier exists — it is confirmed immediately, so email keeps
 * working on a server without a verification mod. Pending addresses are intentionally not indexed
 * for uniqueness; a collision is resolved when one side is confirmed (see `verifyPendingEmail`), so
 * at most one account can ever own a given address.
 */
export async function setEmail(db: Database, userId: string, email: string) {
	const verifiers = [ ...hooks.map('verifyEmail') ];
	const gate = config.backend.autoVerifyEmail === false && verifiers.length > 0;
	if (!gate) {
		if (!await associateEmail(db, userId, email)) {
			throw new Error('Already associated');
		}
		await db.data.hDel(infoKey(userId), [ pendingEmailField ]);
		return { pending: false };
	}
	await db.data.hSet(infoKey(userId), pendingEmailField, email);
	await Fn.mapAwait(verifiers, fn => fn(db, userId, email));
	return { pending: true };
}

/** The address a user is currently waiting to confirm, or `null`. */
export function pendingEmailForUser(db: Database, userId: string) {
	return db.data.hGet(infoKey(userId), pendingEmailField);
}

/**
 * Confirm a user's pending address, promoting it to their `email` provider. `email` must match the
 * currently-pending address (guards against a stale/superseded link). Returns `false` when it
 * doesn't match, or when the address was meanwhile confirmed by another account.
 */
export async function verifyPendingEmail(db: Database, userId: string, email: string) {
	const pending = await db.data.hGet(infoKey(userId), pendingEmailField);
	if (pending !== email) {
		return false;
	}
	// A different account may have confirmed the same address while this one was pending.
	if (!await associateEmail(db, userId, email)) {
		return false;
	}
	await db.data.hDel(infoKey(userId), [ pendingEmailField ]);
	return true;
}

/**
 * Deletes a user's database records: lookup entries, info, and code. Room objects owned by the
 * user are unaffected.
 */
export async function remove(db: Database, userId: string) {
	const [ providers, branches ] = await Promise.all([
		findProvidersForUser(db, userId),
		db.data.sMembers(branchManifestKey(userId)),
	]);
	await Promise.all([
		db.data.sRem('users', [ userId ]),
		db.data.del(infoKey(userId)),
		db.data.del(userProvidersKey(userId)),
		db.data.del(branchManifestKey(userId)),
		...Fn.map(Object.entries(providers), ([ provider, providerId ]) =>
			db.data.hDel(providerMembersKey(provider), [ providerId ])),
		...Fn.transform(branches, branchName => [
			db.data.vDel(buffersKey(userId, branchName)),
			db.data.vDel(stringsKey(userId, branchName)),
		]),
		...removeHooks(db, userId),
	]);
}

export function findProvidersForUser(db: Database, userId: string) {
	return db.data.hGetAll(userProvidersKey(userId));
}

export function providerIdForUser(db: Database, provider: string, userId: string) {
	return db.data.hGet(userProvidersKey(userId), provider);
}

export async function findUserByProvider(db: Database, provider: string, providerId: string) {
	return db.data.hGet(providerMembersKey(provider), providerId);
}

export async function findUserByName(db: Database, username: string) {
	return findUserByProvider(db, 'username', flattenUsername(username));
}

export async function loadBackendUserInfo(db: Database, userId: string): Promise<BackendUserInfo | undefined> {
	const info = await db.data.hmGet(infoKey(userId), [ 'badge', 'username' ]);
	if (info.username != null) {
		return {
			username: info.username,
			badge: info.badge == null ? null : JSON.parse(info.badge) as Badge,
		};
	}
}
