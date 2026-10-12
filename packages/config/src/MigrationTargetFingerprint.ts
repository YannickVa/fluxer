// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';

export function isMigrationRunId(value: unknown): value is string {
	return (
		typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	);
}

export interface MigrationTargetConfig {
	database: {backend: string};
	postgres: {url?: string; host?: string; port?: number; database?: string; kvTable?: string};
	s3: {endpoint: string; buckets: {cdn: string}};
}

/** Identify the effective data stores, never their credentials. No network access. */
export function migrationTargetFingerprint(config: MigrationTargetConfig): string {
	if (config.database.backend !== 'postgres') throw new Error('Migration requires the postgres backend.');
	let host = config.postgres.host ?? '127.0.0.1';
	let port = config.postgres.port ?? 5432;
	let database = config.postgres.database ?? 'fluxer';
	if (config.postgres.url) {
		let url: URL;
		try {
			url = new URL(config.postgres.url);
		} catch {
			throw new Error('Invalid Postgres target URL (credentials omitted).');
		}
		if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1))
			throw new Error('Postgres target URL must specify a host and database.');
		// pg accepts connection overrides in URL query parameters. Fingerprint the
		// same destination it will connect to, or refuse an unsupported override.
		if ([...url.searchParams.keys()].some((key) => !['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].includes(key)))
			throw new Error('Unsupported Postgres target URL query parameters; use explicit connection fields.');
		host = url.hostname;
		port = url.port ? Number(url.port) : 5432;
		database = decodeURIComponent(url.pathname.slice(1));
	}
	if (!host.trim() || !database.trim() || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('Postgres target must have an explicit host, database, and valid port.');
	let endpoint: URL;
	try {
		endpoint = new URL(config.s3.endpoint);
	} catch {
		throw new Error('Invalid S3 target endpoint (credentials omitted).');
	}
	if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.search || endpoint.hash)
		throw new Error('S3 target endpoint must be HTTP(S) without query parameters or fragments.');
	endpoint.username = '';
	endpoint.password = '';
	return createHash('sha256')
		.update(
			JSON.stringify({
				host: host.toLowerCase(),
				port,
				database,
				kv_table: config.postgres.kvTable ?? 'fluxer_kv',
				s3_endpoint: endpoint.href.replace(/\/$/, ''),
				cdn_bucket: config.s3.buckets.cdn,
			}),
		)
		.digest('hex');
}
