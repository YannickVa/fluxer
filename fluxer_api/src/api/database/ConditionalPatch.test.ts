// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import {types} from 'cassandra-driver';
import {describe, expect, it, vi} from 'vitest';
import {InMemoryCassandraQueryExecutor} from '../test/InMemoryCassandraQueryExecutor';
import {BatchBuilder} from './CassandraQueryExecution';
import {defineTable} from './CassandraTableDsl';
import {Db} from './CassandraTypes';
import {PostgresKvQueryExecutor} from './PostgresKvQueryExecutor';

interface ClaimRow {
	id: string;
	version: number;
	email: string | null;
	dob: types.LocalDate | null;
	traits: Set<string> | null;
	value: string;
	condition_value_0: string | null;
}

const Rows = defineTable<ClaimRow, 'id'>({
	name: 'conditional_claim_test_rows',
	columns: ['id', 'version', 'email', 'dob', 'traits', 'value', 'condition_value_0'],
	primaryKey: ['id'],
});

async function fixture() {
	const db = new InMemoryCassandraQueryExecutor();
	const original: ClaimRow = {
		id: 'synthetic',
		version: 1,
		email: null,
		dob: null,
		traits: new Set(['migrated', 'bound']),
		value: 'original',
		condition_value_0: null,
	};
	await db.executeQuery(Rows.upsertAll(original));
	return {db, original};
}

describe('Conditional claim-write query primitive', () => {
	it('binds expected values separately from patch values without interpolating data or colliding with real columns', () => {
		const query = Rows.patchByPkIf(
			{id: 'synthetic'},
			{email: Db.set('synthetic@example.com'), version: Db.set(2)},
			{email: null, version: 1},
		);
		expect(query.cql).toContain(' IF version = :condition_value_0_ AND email = :condition_value_1;');
		expect(query.cql).not.toContain('synthetic');
		expect(query.params).toMatchObject({
			version: 2,
			email: 'synthetic@example.com',
			condition_value_0_: 1,
			condition_value_1: null,
		});
	});

	it('allows exactly one concurrent claimant and preserves fields not present in the patch', async () => {
		const {db} = await fixture();
		const results = await Promise.all(
			Array.from({length: 20}, (_, i) =>
				db.executeQuery<{'[applied]': boolean}>(
					Rows.patchByPkIf(
						{id: 'synthetic'},
						{email: Db.set(`synthetic-${i}@example.com`), version: Db.set(2)},
						{version: 1, email: null, dob: null},
					),
				),
			),
		);
		expect(results.filter((rows) => rows[0]?.['[applied]'])).toHaveLength(1);
		const [stored] = await db.executeQuery<ClaimRow>(Rows.select({where: Rows.where.eq('id')}).bind({id: 'synthetic'}));
		expect(stored).toMatchObject({version: 2, value: 'original', dob: null});
		expect(stored!.traits).toEqual(new Set(['migrated', 'bound']));
	});

	it('refuses any changed expected field even when its version was not incremented', async () => {
		const {db} = await fixture();
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
	});

	it('compares sets without ordering and calendar dates by value', async () => {
		const {db} = await fixture();
		await db.executeQuery(Rows.patchByPk({id: 'synthetic'}, {dob: Db.set(types.LocalDate.fromString('2000-02-29'))}));
		expect(
			await db.executeQuery(
				Rows.patchByPkIf(
					{id: 'synthetic'},
					{value: Db.set('changed')},
					{traits: new Set(['bound', 'migrated']), dob: types.LocalDate.fromString('2000-02-29')},
				),
			),
		).toEqual([{'[applied]': true}]);
	});

	it('never creates a missing row or turns null guards into unconditional writes', async () => {
		const {db} = await fixture();
		expect(
			await db.executeQuery(Rows.patchByPkIf({id: 'missing'}, {email: Db.set('synthetic@example.com')}, {email: null})),
		).toEqual([{'[applied]': false}]);
		expect(await db.executeQuery(Rows.select({where: Rows.where.eq('id')}).bind({id: 'missing'}))).toEqual([]);
	});

	it('rejects malformed empty conditional metadata instead of silently writing without a guard', async () => {
		const {db} = await fixture();
		const query = Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('unsafe')}, {email: null});
		const malformed = {...query, kvMeta: {...query.kvMeta!, conditions: []}};
		await expect(db.executeQuery(malformed)).rejects.toThrow('requires expected values');
		const sql = vi.fn();
		const pg = new PostgresKvQueryExecutor({query: sql, kvTable: () => 'synthetic_kv'} as unknown as IPostgresClient);
		await expect(pg.executeQuery(malformed)).rejects.toThrow('requires expected values');
		expect(sql).not.toHaveBeenCalled();
		const [stored] = await db.executeQuery<ClaimRow>(Rows.select({where: Rows.where.eq('id')}).bind({id: 'synthetic'}));
		expect(stored!.value).toBe('original');
	});

	it('never treats a missing expected parameter as a null guard', async () => {
		const {db} = await fixture();
		const query = Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('unsafe')}, {email: null});
		const sql = vi.fn();
		const pg = new PostgresKvQueryExecutor({query: sql, kvTable: () => 'synthetic_kv'} as unknown as IPostgresClient);
		for (const params of [
			{id: 'synthetic', value: 'unsafe'},
			{...query.params, condition_value_0_: undefined},
		]) {
			// Deliberately malformed bindings must be refused even if a caller bypasses types.
			await expect(db.executeQuery({...query, params: params as never})).rejects.toThrow('missing an expected value');
			await expect(pg.executeQuery({...query, params: params as never})).rejects.toThrow('missing an expected value');
		}
		expect(sql).not.toHaveBeenCalled();
	});

	it('refuses batching a conditional write because a void batch cannot report its application result', async () => {
		const {db} = await fixture();
		const query = Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('unsafe')}, {email: null});
		const sql = vi.fn();
		const transaction = vi.fn();
		const pg = new PostgresKvQueryExecutor({
			query: sql,
			transaction,
			kvTable: () => 'synthetic_kv',
		} as unknown as IPostgresClient);
		const batch = [{query: query.cql, params: query.params, meta: query.kvMeta}];
		await expect(new BatchBuilder().addPrepared(query).execute()).rejects.toThrow('must execute individually');
		await expect(db.executeBatch(batch)).rejects.toThrow('must execute individually');
		await expect(pg.executeBatch(batch, true)).rejects.toThrow('must execute individually');
		await expect(pg.executeBatch(batch, false)).rejects.toThrow('must execute individually');
		expect(sql).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		const [stored] = await db.executeQuery<ClaimRow>(Rows.select({where: Rows.where.eq('id')}).bind({id: 'synthetic'}));
		expect(stored!.value).toBe('original');
	});

	it('rejects empty guards, undefined values, unknown/primary-key columns and incomplete primary keys', () => {
		expect(() => Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('changed')}, {})).toThrow('expected column');
		expect(() => Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('changed')}, {email: undefined})).toThrow(
			'undefined expected',
		);
		expect(() => Rows.patchByPkIf({id: 'synthetic'}, {}, {email: null})).toThrow('empty PATCH');
		expect(() => Rows.patchByPkIf({id: 'synthetic'}, {value: Db.set('changed')}, {id: 'unsafe'} as never)).toThrow(
			'primary-key',
		);
		expect(() => Rows.patchByPkIf({id: 'synthetic'}, {unknown: Db.set('unsafe')} as never, {email: null})).toThrow(
			'unknown',
		);
		expect(() => Rows.patchByPkIf({} as never, {value: Db.set('changed')}, {email: null})).toThrow(
			'complete primary key',
		);
	});

	it.each([0, 1])('uses a single conditional PostgreSQL UPDATE and reports actual row count %s', async (rowCount) => {
		const query = vi.fn(async () => ({rowCount, rows: []}));
		const client = {query, kvTable: () => 'synthetic_kv'} as unknown as IPostgresClient;
		const db = new PostgresKvQueryExecutor(client);
		const result = await db.executeQuery(
			Rows.patchByPkIf(
				{id: 'synthetic'},
				{email: Db.set('synthetic@example.com'), dob: Db.set(types.LocalDate.fromString('2000-02-29'))},
				{email: null, version: 1, traits: new Set(['bound', 'migrated'])},
			),
		);
		expect(result).toEqual([{'[applied]': rowCount === 1}]);
		expect(query).toHaveBeenCalledTimes(1);
		const [sql, params] = query.mock.calls[0]! as unknown as [string, Array<string>];
		expect(sql).toContain('UPDATE "synthetic_kv"');
		expect(sql).toContain('row_data = row_data || $3::jsonb');
		expect(sql).toContain('expires_at > now()');
		expect(sql).toContain('IS DISTINCT FROM expected.value');
		expect(sql).toContain('expected.value @>');
		expect(sql).not.toContain('synthetic@example.com');
		expect(JSON.parse(params[2]!)).toEqual({
			email: 'synthetic@example.com',
			dob: {__fluxer_type: 'local_date', value: '2000-02-29'},
		});
		expect(JSON.parse(params[3]!)).toEqual({
			email: null,
			version: 1,
			traits: {__fluxer_type: 'set', value: ['bound', 'migrated']},
		});
	});
});
