// SPDX-License-Identifier: AGPL-3.0-or-later

export type SupportCheckStatus = 'checking' | 'pass' | 'warning' | 'fail' | 'neutral';

export interface SupportEndpointCheck {
	service: 'app' | 'api' | 'media';
	status: 'pass' | 'fail';
	httpStatus: number | null;
	durationMs: number | null;
	error: 'timeout' | 'network' | null;
}

export interface SupportReadinessStep {
	id: 'instance' | 'messaging' | 'voice' | 'devices' | 'update';
	status: SupportCheckStatus;
}

export interface SupportDiagnosticsSnapshot {
	schemaVersion: 1;
	generatedAt: string;
	product: {
		name: string;
		instanceOrigin: string;
		selfHosted: boolean;
		voiceEnabled: boolean;
	};
	build: {
		webVersion: string;
		releaseChannel: string;
		desktopVersion: string | null;
		desktopChannel: string | null;
	};
	client: {
		os: string | null;
		osVersion: string | null;
		architecture: string | null;
		browser: string | null;
		browserVersion: string | null;
		desktop: boolean;
	};
	connectivity: {
		browserOnline: boolean;
		gateway: 'ready' | 'connecting' | 'disconnected';
		checks: Array<SupportEndpointCheck>;
	};
	media: {
		microphonePermission: PermissionState | 'unknown';
		cameraPermission: PermissionState | 'unknown';
		inputDeviceCount: number;
		outputDeviceCount: number;
		cameraDeviceCount: number;
		voiceSession: 'connected' | 'connecting' | 'reconnecting' | 'not-connected';
		connectionQuality: string | null;
		latencyMs: number | null;
	};
	update: {
		state: string;
		currentVersion: string | null;
		availableVersion: string | null;
		channel: string | null;
		lastCheckedAt: string | null;
		updateAvailable: boolean;
		downloadReady: boolean;
		unsupportedReason: string | null;
	};
}

export interface CreateSupportDiagnosticsInput
	extends Omit<SupportDiagnosticsSnapshot, 'schemaVersion' | 'generatedAt'> {
	generatedAt?: Date;
}

const STATUS_PRIORITY: Record<SupportCheckStatus, number> = {
	checking: 4,
	fail: 3,
	warning: 2,
	pass: 1,
	neutral: 0,
};

export function getOverallSupportStatus(steps: ReadonlyArray<SupportReadinessStep>): SupportCheckStatus {
	if (steps.length === 0) return 'neutral';
	return steps.reduce<SupportCheckStatus>(
		(current, step) => (STATUS_PRIORITY[step.status] > STATUS_PRIORITY[current] ? step.status : current),
		'neutral',
	);
}

export function getHealthCheckUrl(endpoint: string): string | null {
	try {
		const url = new URL(endpoint);
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/_health`;
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

export function getSafeOrigin(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return 'unknown';
	}
}

export async function runEndpointHealthCheck(
	service: SupportEndpointCheck['service'],
	endpoint: string,
	options: {timeoutMs?: number; fetchImpl?: typeof fetch} = {},
): Promise<SupportEndpointCheck> {
	const healthUrl = getHealthCheckUrl(endpoint);
	if (!healthUrl) {
		return {service, status: 'fail', httpStatus: null, durationMs: null, error: 'network'};
	}
	const timeoutMs = options.timeoutMs ?? 5000;
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
	const startedAt = performance.now();
	try {
		const response = await fetchImpl(healthUrl, {
			method: 'GET',
			cache: 'no-store',
			credentials: 'omit',
			signal: controller.signal,
		});
		return {
			service,
			status: response.ok ? 'pass' : 'fail',
			httpStatus: response.status,
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
			error: null,
		};
	} catch (error) {
		return {
			service,
			status: 'fail',
			httpStatus: null,
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
			error: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network',
		};
	} finally {
		globalThis.clearTimeout(timeout);
	}
}

export function createSupportDiagnosticsSnapshot(input: CreateSupportDiagnosticsInput): SupportDiagnosticsSnapshot {
	const {generatedAt = new Date(), ...snapshot} = input;
	return {
		schemaVersion: 1,
		generatedAt: generatedAt.toISOString(),
		...snapshot,
	};
}

export function serializeSupportDiagnostics(snapshot: SupportDiagnosticsSnapshot): string {
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}
