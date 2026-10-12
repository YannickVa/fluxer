// SPDX-License-Identifier: AGPL-3.0-or-later

import {PGlite} from '@electric-sql/pglite';
import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import {types} from 'cassandra-driver';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {defineTable} from './CassandraTableDsl';
import {Db} from './CassandraTypes';
import {MigrationClaimReadiness, type MigrationClaimReadinessRow} from './MigrationClaimReadiness';
import {PostgresKvQueryExecutor} from './PostgresKvQueryExecutor';

interface SyntheticRow {
	id: string;
	version: number;
	email: string | null;
	dob: types.LocalDate | null;
	traits: Set<string> | null;
	value: string | null;
}

const Rows = defineTable<SyntheticRow, 'id'>({
	name: 'postgres_synthetic_claims',
	columns: ['id', 'version', 'email', 'dob', 'traits', 'value'],
	primaryKey: ['id'],
});
const original: SyntheticRow = {
	id: 'synthetic',
	version: 1,
	email: null,
	dob: null,
	traits: new Set(['migrated', 'bound']),
	value: 'original',
};

describe('PostgreSQL KV writes against an ephemeral embedded PostgreSQL engine', () => {
	let pg: PGlite;
	let db: PostgresKvQueryExecutor;
	let nextWrite: (() => Promise<void>) | null = null;

	beforeAll(async () => {
		pg = await PGlite.create('memory://');
		await pg.exec(`CREATE TABLE synthetic_kv (
		 table_name text NOT NULL, partition_key text NOT NULL, row_key text NOT NULL,
		 row_data jsonb NOT NULL, expires_at timestamptz, updated_at timestamptz NOT NULL,
		 PRIMARY KEY (table_name, row_key)
		)`);
		const client = {
			kvTable: () => 'synthetic_kv',
			query: async (sql: string, values?: Array<unknown>) => {
				if (sql.trim().startsWith('INSERT') && nextWrite) {
					const wait = nextWrite;
					nextWrite = null;
					await wait();
				}
				const result = await pg.query(sql, values);
				return {rows: result.rows, rowCount: result.affectedRows ?? 0, command: '', oid: 0, fields: []};
			},
		} as unknown as IPostgresClient;
		db = new PostgresKvQueryExecutor(client);
	}, 20000);

	beforeEach(async () => {
		nextWrite = null;
		await pg.exec('TRUNCATE synthetic_kv');
		await db.executeQuery(Rows.upsertAll(original));
	});

	afterAll(async () => {
		await pg?.close();
	});

	async function stored() {
		const [row] = await db.executeQuery<SyntheticRow>(
			Rows.select({where: Rows.where.eq('id')}).bind({id: 'synthetic'}),
		);
		return row!;
	}

	it('preserves independent concurrent patches instead of writing stale full-row copies', async () => {
		await Promise.all([
			db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {email: Db.set('synthetic@example.com')})),
			db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {value: Db.set('changed')})),
			db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {dob: Db.set(types.LocalDate.fromString('2000-02-29'))})),
		]);
		const row = await stored();
		expect(row.email).toBe('synthetic@example.com');
		expect(row.value).toBe('changed');
		expect(row.dob?.toString()).toBe('2000-02-29');
		expect(row.traits).toEqual(original.traits);
	});

	it('a partial upsert paused before its write cannot undo a later completed claim', async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		nextWrite = async () => {
			reached.resolve();
			await release.promise;
		};
		const partialUpsert = db.executeQuery(Rows.upsertAll({id: 'synthetic', value: 'changed'} as SyntheticRow));
		try {
			await reached.promise;
			expect(
				await db.executeQuery(
					Rows.patchByPkIf(
						{id: 'synthetic'},
						{email: Db.set('synthetic@example.com'), version: Db.set(2)},
						{email: null, version: 1},
					),
				),
			).toEqual([{'[applied]': true}]);
		} finally {
			release.resolve();
		}
		await partialUpsert;
		expect(await stored()).toMatchObject({email: 'synthetic@example.com', version: 2, value: 'changed'});
	});

	it('a paused partial upsert does not resurrect data after another request deletes the row', async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		nextWrite = async () => {
			reached.resolve();
			await release.promise;
		};
		const partialUpsert = db.executeQuery(Rows.upsertAll({id: 'synthetic', value: 'new'} as SyntheticRow));
		try {
			await reached.promise;
			await pg.exec('DELETE FROM synthetic_kv');
		} finally {
			release.resolve();
		}
		await partialUpsert;
		expect(await stored()).toEqual({id: 'synthetic', value: 'new'});
	});

	it('allows only one conditional claimant across competing asynchronous requests', async () => {
		const results = await Promise.all(
			Array.from({length: 20}, (_, i) =>
				db.executeQuery<{'[applied]': boolean}>(
					Rows.patchByPkIf(
						{id: 'synthetic'},
						{email: Db.set(`synthetic-${i}@example.com`), version: Db.set(2)},
						{email: null, version: 1, dob: null},
					),
				),
			),
		);
		expect(results.filter((rows) => rows[0]?.['[applied]'])).toHaveLength(1);
		expect(await stored()).toMatchObject({version: 2, value: 'original'});
	});

	it('refuses changed privileges without relying on a version increment', async () => {
		await db.executeQuery(
			Rows.patchByPk({id: 'synthetic'}, {traits: Db.set(new Set(['migrated', 'bound', 'privileged']))}),
		);
		expect(
			await db.executeQuery(
				Rows.patchByPkIf(
					{id: 'synthetic'},
					{email: Db.set('synthetic@example.com')},
					{version: 1, traits: new Set(['bound', 'migrated'])},
				),
			),
		).toEqual([{'[applied]': false}]);
		expect((await stored()).email).toBeNull();
	});

	it('compares unordered sets and null/missing values while preserving unpatched data', async () => {
		await pg.query("UPDATE synthetic_kv SET row_data = row_data - 'dob'");
		expect(
			await db.executeQuery(
				Rows.patchByPkIf(
					{id: 'synthetic'},
					{value: Db.set('changed')},
					{traits: new Set(['bound', 'migrated']), dob: null},
				),
			),
		).toEqual([{'[applied]': true}]);
		expect((await stored()).email).toBeNull();
	});

	it('compares birth dates by calendar value and does not accept a changed birth date', async () => {
		await db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {dob: Db.set(types.LocalDate.fromString('2000-02-29'))}));
		expect(
			await db.executeQuery(
				Rows.patchByPkIf(
					{id: 'synthetic'},
					{value: Db.set('changed')},
					{dob: types.LocalDate.fromString('2000-02-29')},
				),
			),
		).toEqual([{'[applied]': true}]);
		expect(await db.executeQuery(Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('unsafe')}, {dob: null}))).toEqual([
			{'[applied]': false},
		]);
	});

	it('never creates missing or expired rows through conditional patches', async () => {
		expect(await db.executeQuery(Rows.patchByPkIf({id: 'missing'}, {value: Db.set('unsafe')}, {email: null}))).toEqual([
			{'[applied]': false},
		]);
		await pg.query("UPDATE synthetic_kv SET expires_at = now() - interval '1 second'");
		expect(
			await db.executeQuery(Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('unsafe')}, {email: null})),
		).toEqual([{'[applied]': false}]);
		expect(await db.executeQuery(Rows.select().bind({}))).toEqual([]);
	});

	it('preserves row TTL on ordinary patches, and changes it only when explicitly requested', async () => {
		await db.executeQuery(Rows.patchByPkWithTtl({id: 'synthetic'}, {value: Db.set('temporary')}, 60));
		const expiry = (await pg.query<{expires_at: Date}>('SELECT expires_at FROM synthetic_kv')).rows[0]!.expires_at;
		await db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {email: Db.set('synthetic@example.com')}));
		expect((await pg.query<{expires_at: Date}>('SELECT expires_at FROM synthetic_kv')).rows[0]!.expires_at).toEqual(
			expiry,
		);
		await db.executeQuery(Rows.patchByPkWithTtl({id: 'synthetic'}, {value: Db.set('renewed')}, 120));
		const later = (await pg.query<{expires_at: Date}>('SELECT expires_at FROM synthetic_kv')).rows[0]!.expires_at;
		expect(later.getTime()).toBeGreaterThan(expiry.getTime());
	});

	it.each([
		'patch',
		'patchWithTtl',
		'upsert',
	] as const)('treats an expired row as absent during %s, without resurrecting its data', async (operation) => {
		await pg.query("UPDATE synthetic_kv SET expires_at = now() - interval '1 second'");
		const query =
			operation === 'upsert'
				? Rows.upsertAll({id: 'synthetic', value: 'new'} as SyntheticRow)
				: operation === 'patchWithTtl'
					? Rows.patchByPkWithTtl({id: 'synthetic'}, {value: Db.set('new')}, 60)
					: Rows.patchByPk({id: 'synthetic'}, {value: Db.set('new')});
		await db.executeQuery(query);
		expect(await stored()).toEqual({id: 'synthetic', value: 'new'});
		const expiry = (await pg.query<{expires_at: Date | null}>('SELECT expires_at FROM synthetic_kv')).rows[0]!
			.expires_at;
		expect(expiry !== null).toBe(operation === 'patchWithTtl');
	});

	it('allows insert-if-absent to replace an expired generation but never keeps its fields', async () => {
		await pg.query("UPDATE synthetic_kv SET expires_at = now() - interval '1 second'");
		const replacement = {...original, version: 2, value: 'new', traits: null};
		expect(await db.executeQuery(Rows.insertIfNotExists(replacement))).toEqual([{'[applied]': true}]);
		expect(await stored()).toEqual(replacement);
	});

	it('honours explicit clear operations without removing unrelated fields', async () => {
		await db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {value: Db.clear()}));
		expect(await stored()).toMatchObject({value: null, version: 1, email: null});
		expect((await stored()).traits).toEqual(original.traits);
	});

	it('retains atomic insert-if-absent semantics and never overwrites an existing row', async () => {
		const results = await Promise.all(
			Array.from({length: 20}, (_, i) =>
				db.executeQuery<{'[applied]': boolean}>(
					Rows.insertIfNotExists({...original, id: 'new', value: `candidate-${i}`}),
				),
			),
		);
		expect(results.filter((rows) => rows[0]?.['[applied]'])).toHaveLength(1);
		expect(await db.executeQuery(Rows.insertIfNotExists({...original, value: 'unsafe'}))).toEqual([
			{'[applied]': false},
		]);
		expect((await stored()).value).toBe('original');
	});

	it('round-trips claim readiness dates and deletes only the active binding, idempotently', async () => {
		const readiness: MigrationClaimReadinessRow = {
			scope: 'active',
			instance_fingerprint: 'a'.repeat(64),
			migration_run_id: '09b913fe-6ac7-4b53-bb87-3cbd04a3e38c',
			source_guild_id: '123',
			state: 'ready',
			verified_at: new Date('2026-01-01T00:00:00.000Z'),
		};
		await db.executeQuery(MigrationClaimReadiness.upsertAll(readiness));
		await db.executeQuery(MigrationClaimReadiness.upsertAll({...readiness, scope: 'other'}));
		const read = () =>
			db.executeQuery<MigrationClaimReadinessRow>(
				MigrationClaimReadiness.select({where: MigrationClaimReadiness.where.eq('scope')}).bind({scope: 'active'}),
			);
		expect(await read()).toEqual([readiness]);
		await db.executeQuery(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
		await db.executeQuery(MigrationClaimReadiness.deleteByPk({scope: 'active'}));
		expect(await read()).toEqual([]);
		expect(
			await db.executeQuery<MigrationClaimReadinessRow>(
				MigrationClaimReadiness.select({where: MigrationClaimReadiness.where.eq('scope')}).bind({scope: 'other'}),
			),
		).toEqual([{...readiness, scope: 'other'}]);
		expect(await stored()).toEqual(original);
	});
});
