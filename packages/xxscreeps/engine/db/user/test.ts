import { config } from 'xxscreeps/config/index.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import * as Badge from './badge.js';
import * as User from './index.js';

describe('engine/db/user', () => {
	test('Badge.generateRandom produces a schema-valid badge', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		// A color channel below 0x100000 renders as fewer than six hex digits; without
		// zero-padding that fails the `^#[a-f0-9]{6}$` schema (~1/16 per channel), so loop
		// enough times to surface it. validate() throws on a malformed badge.
		for (let index = 0; index < 256; ++index) {
			const badge = Badge.generateRandom();
			assert.strictEqual(await Badge.validate(db, '100', badge), badge);
		}
	});

	test('removed user is no longer found', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		await User.create(db, '200', 'RemoveMe', [ { provider: 'email', id: 'remove@me.test' } ]);
		await User.remove(db, '200');
		assert.strictEqual(await User.findUserByName(db, 'RemoveMe'), null);
		assert.strictEqual(await User.findUserByProvider(db, 'email', 'remove@me.test'), null);
	});
});

describe('User.setEmail', () => {
	test('auto-verifies when no verification mod is installed', async () => {
		// Default config: with no `verifyEmail` handler, the address is confirmed immediately.
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		await User.create(db, '300', 'AutoVerify', [ { provider: 'email', id: 'auto@test.dev' } ]);
		assert.strictEqual(await User.findUserByProvider(db, 'email', 'auto@test.dev'), '300');
		assert.strictEqual(await User.pendingEmailForUser(db, '300'), null);
	});

	test('holds pending then promotes on confirmation when gated', async () => {
		await using testShard = await instantiateTestShard();
		const { db } = testShard;
		// A verifier being registered plus `autoVerifyEmail: false` is what enables gating. (The hook
		// registration leaks past this test, but is harmless: it only fires while gating is on.)
		const notified: string[] = [];
		User.hooks.register('verifyEmail', (innerDb, userId, email) => { notified.push(`${userId}:${email}`); });
		const previous = config.backend.autoVerifyEmail;
		config.backend.autoVerifyEmail = false;
		try {
			await User.create(db, '301', 'Gated', [ { provider: 'email', id: 'gated@test.dev' } ]);
			// Held pending: stored as pendingEmail, not yet a provider, verifier notified.
			assert.strictEqual(await User.pendingEmailForUser(db, '301'), 'gated@test.dev');
			assert.strictEqual(await User.findUserByProvider(db, 'email', 'gated@test.dev'), null);
			assert.deepStrictEqual(notified, [ '301:gated@test.dev' ]);
			// A mismatched address is rejected and changes nothing.
			assert.strictEqual(await User.verifyPendingEmail(db, '301', 'wrong@test.dev'), false);
			assert.strictEqual(await User.findUserByProvider(db, 'email', 'gated@test.dev'), null);
			// Confirming the pending address promotes it to the `email` provider and clears pending.
			assert.strictEqual(await User.verifyPendingEmail(db, '301', 'gated@test.dev'), true);
			assert.strictEqual(await User.findUserByProvider(db, 'email', 'gated@test.dev'), '301');
			assert.strictEqual(await User.pendingEmailForUser(db, '301'), null);
		} finally {
			if (previous === undefined) {
				delete config.backend.autoVerifyEmail;
			} else {
				config.backend.autoVerifyEmail = previous;
			}
		}
	});
});
