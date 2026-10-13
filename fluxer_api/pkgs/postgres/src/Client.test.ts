// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import pg from 'pg';
import {getDefaultPostgresClient, initPostgres, shutdownPostgres} from './Client';

type FakeOptions = {
	locked?: boolean;
	unlocked?: boolean;
	acquisitionFailure?: boolean;
	unlockFailure?: boolean;
	lossDuringAcquire?: boolean;
};

async function withFakePool(
	options: FakeOptions,
	action: (clients: Array<ReturnType<typeof fakeClient>>) => Promise<void>,
) {
	const original = pg.Pool;
	const clients: Array<ReturnType<typeof fakeClient>> = [];
	pg.Pool = class extends EventEmitter {
		async connect() {
			const client = fakeClient(options);
			clients.push(client);
			const release = client.release.bind(client);
			client.release = (discard?: boolean) => {
				release(discard);
				this.emit('release', null, client);
			};
			this.emit('acquire', client);
			return client;
		}
		async query() {
			assert.fail('Advisory operations must use a dedicated session, not pool.query');
		}
		async end() {}
	} as unknown as typeof pg.Pool;
	try {
		await initPostgres({});
		await action(clients);
	} finally {
		await shutdownPostgres();
		pg.Pool = original;
	}
}

function fakeClient(options: FakeOptions) {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		queries: [] as Array<{text: string; values: Array<unknown>}>,
		releases: [] as Array<boolean | undefined>,
		async query(text: string, values: Array<unknown>) {
			this.queries.push({text, values});
			if (text.includes('pg_try_advisory_lock')) {
				if (options.acquisitionFailure) throw new Error('Synthetic acquisition failure');
				if (options.lossDuringAcquire) emitter.emit('error', new Error('Synthetic session loss'));
				return {rows: [{locked: options.locked ?? true}]};
			}
			assert.ok(text.includes('pg_advisory_unlock'));
			if (options.unlockFailure) throw new Error('Synthetic unlock failure');
			return {rows: [{unlocked: options.unlocked ?? true}]};
		},
		release(discard?: boolean) {
			this.releases.push(discard);
		},
	});
}

test('advisory success uses and releases one dedicated session with the exact bigint key', async () => {
	await withFakePool({}, async (clients) => {
		const key = 0x666c757865727379n;
		assert.equal(await getDefaultPostgresClient().withAdvisoryLock(key, async () => 42), 42);
		assert.equal(clients.length, 2); // Initial connection check, then the dedicated lock holder.
		assert.deepEqual(clients[0].queries, []);
		assert.equal(clients[1].queries.length, 2);
		for (const query of clients[1].queries) assert.deepEqual(query.values, [key.toString()]);
		assert.deepEqual(clients[1].releases, [false]);
		assert.equal(clients[1].listenerCount('error'), 0);
	});
});

test('advisory contention refuses the callback without unlocking someone else’s lock', async () => {
	await withFakePool({locked: false}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async () => assert.fail('Competing callback ran')),
			/Another operation/,
		);
		assert.equal(clients[1].queries.length, 1);
		assert.deepEqual(clients[1].releases, [false]);
	});
});

test('advisory callback failure still unlocks its session', async () => {
	await withFakePool({}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async () => {
				throw new Error('Synthetic callback failure');
			}),
			/Synthetic callback failure/,
		);
		assert.equal(clients[1].queries.length, 2);
		assert.deepEqual(clients[1].releases, [false]);
	});
});

test('uncertain acquisition failure discards the connection instead of returning a possible lock to the pool', async () => {
	await withFakePool({acquisitionFailure: true}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async () => assert.fail('Failed acquisition ran')),
			/Synthetic acquisition failure/,
		);
		assert.equal(clients[1].queries.length, 1);
		assert.deepEqual(clients[1].releases, [true]);
	});
});

test('unlock failure or lost ownership discards the connection and rejects success', async () => {
	for (const options of [{unlockFailure: true}, {unlocked: false}]) {
		await withFakePool(options, async (clients) => {
			await assert.rejects(
				getDefaultPostgresClient().withAdvisoryLock(1n, async () => 42),
				/unlock|ownership/,
			);
			assert.deepEqual(clients[1].releases, [true]);
		});
	}
});

test('session loss aborts the callback signal and rejects continuing without a lock', async () => {
	await withFakePool({}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async (signal) => {
				clients[1].emit('error', new Error('Synthetic session loss'));
				assert.equal(signal.aborted, true);
				return 42;
			}),
			/connection lost/,
		);
		assert.equal(clients[1].queries.length, 1);
		assert.deepEqual(clients[1].releases, [true]);
	});
});

test('callback and cleanup failures are both preserved rather than masking the original error', async () => {
	await withFakePool({unlockFailure: true}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async () => {
				throw new Error('Synthetic callback failure');
			}),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.deepEqual(
					error.errors.map((item: Error) => item.message),
					['Synthetic callback failure', 'Synthetic unlock failure'],
				);
				return true;
			},
		);
		assert.deepEqual(clients[1].releases, [true]);
	});
});

test('loss during acquisition refuses the callback even if a successful reply arrives', async () => {
	await withFakePool({lossDuringAcquire: true}, async (clients) => {
		await assert.rejects(
			getDefaultPostgresClient().withAdvisoryLock(1n, async () => assert.fail('Aborted callback ran')),
			/connection lost/,
		);
		assert.deepEqual(clients[1].releases, [true]);
		assert.equal(clients[1].listenerCount('error'), 0);
	});
});

test('shutdown aborts an active advisory operation, drains its cleanup and refuses a new one', async () => {
	await withFakePool({}, async () => {
		let finish!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const client = getDefaultPostgresClient();
		let activeSignal!: AbortSignal;
		const operation = client.withAdvisoryLock(1n, async (signal) => {
			activeSignal = signal;
			entered();
			await gate;
			return 42;
		});
		await started;
		let drained = false;
		const closing = shutdownPostgres().then(() => {
			drained = true;
		});
		await new Promise<void>((resolve) => activeSignal.addEventListener('abort', () => resolve(), {once: true}));
		assert.equal(drained, false);
		assert.equal(activeSignal.aborted, true);
		await assert.rejects(
			client.withAdvisoryLock(2n, async () => assert.fail('New operation ran')),
			/shutting down/,
		);
		finish();
		await assert.rejects(operation, /shutting down/);
		await closing;
		assert.equal(drained, true);
	});
});
