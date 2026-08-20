// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SupportEndpointCheck} from '@app/features/support/SupportCenterDiagnostics';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const ENDPOINT_WAITING_DESCRIPTOR = msg({
	message: 'waiting',
	comment: 'Support Center endpoint check has not run yet.',
});
const ENDPOINT_DURATION_DESCRIPTOR = msg({
	message: '{durationMs} ms',
	comment: 'Support Center endpoint response duration in milliseconds.',
});
const ENDPOINT_TIMEOUT_DESCRIPTOR = msg({message: 'timed out', comment: 'Support Center endpoint check timed out.'});
const ENDPOINT_HTTP_DESCRIPTOR = msg({
	message: 'HTTP {httpStatus}',
	comment: 'Support Center endpoint check returned a non-success HTTP status.',
});
const ENDPOINT_UNREACHABLE_DESCRIPTOR = msg({
	message: 'unreachable',
	comment: 'Support Center endpoint could not be reached.',
});
const PERMISSION_ALLOWED_DESCRIPTOR = msg({message: 'allowed', comment: 'Browser media permission is granted.'});
const PERMISSION_BLOCKED_DESCRIPTOR = msg({message: 'blocked', comment: 'Browser media permission is denied.'});
const PERMISSION_NOT_REQUESTED_DESCRIPTOR = msg({
	message: 'not requested',
	comment: 'Browser media permission has not been requested yet.',
});
const PERMISSION_UNKNOWN_DESCRIPTOR = msg({message: 'unknown', comment: 'Browser media permission state is unknown.'});
const INSTANCE_ENDPOINTS_DESCRIPTOR = msg({
	message: 'App {appSummary} · API {apiSummary}',
	comment: 'Support Center summary of the web app and API endpoint checks.',
});
const MEDIA_ENDPOINT_DESCRIPTOR = msg({
	message: 'Media service {mediaSummary}.',
	comment: 'Support Center summary of the voice and video media endpoint check.',
});
const DEVICE_PERMISSION_SUMMARY_DESCRIPTOR = msg({
	message:
		'{inputCount} microphone(s), {outputCount} speaker(s), {cameraCount} camera(s). Microphone {microphonePermission}; camera {cameraPermission}.',
	comment: 'Support Center device counts and browser microphone and camera permission states.',
});
const UPDATE_AVAILABLE_DESCRIPTOR = msg({
	message: 'Version {version} is available.',
	comment: 'Support Center update status when a newer desktop version is available.',
});
const UPDATE_LAST_CHECKED_DESCRIPTOR = msg({
	message: 'Last checked: {lastUpdateCheck}',
	comment: 'Support Center timestamp of the most recent desktop update check.',
});

export function formatSupportEndpointSummary(i18n: I18n, check: SupportEndpointCheck | undefined): string {
	if (!check) return i18n._(ENDPOINT_WAITING_DESCRIPTOR);
	if (check.status === 'pass') {
		return i18n._(ENDPOINT_DURATION_DESCRIPTOR, {durationMs: check.durationMs ?? 0});
	}
	if (check.error === 'timeout') return i18n._(ENDPOINT_TIMEOUT_DESCRIPTOR);
	if (check.httpStatus) return i18n._(ENDPOINT_HTTP_DESCRIPTOR, {httpStatus: check.httpStatus});
	return i18n._(ENDPOINT_UNREACHABLE_DESCRIPTOR);
}

export function formatSupportPermission(i18n: I18n, value: PermissionState | null): string {
	switch (value) {
		case 'granted':
			return i18n._(PERMISSION_ALLOWED_DESCRIPTOR);
		case 'denied':
			return i18n._(PERMISSION_BLOCKED_DESCRIPTOR);
		case 'prompt':
			return i18n._(PERMISSION_NOT_REQUESTED_DESCRIPTOR);
		default:
			return i18n._(PERMISSION_UNKNOWN_DESCRIPTOR);
	}
}

export function formatSupportInstanceSummary(
	i18n: I18n,
	appCheck: SupportEndpointCheck | undefined,
	apiCheck: SupportEndpointCheck | undefined,
): string {
	return i18n._(INSTANCE_ENDPOINTS_DESCRIPTOR, {
		appSummary: formatSupportEndpointSummary(i18n, appCheck),
		apiSummary: formatSupportEndpointSummary(i18n, apiCheck),
	});
}

export function formatSupportMediaSummary(i18n: I18n, mediaCheck: SupportEndpointCheck | undefined): string {
	return i18n._(MEDIA_ENDPOINT_DESCRIPTOR, {mediaSummary: formatSupportEndpointSummary(i18n, mediaCheck)});
}

export function formatSupportDeviceSummary(
	i18n: I18n,
	inputCount: number,
	outputCount: number,
	cameraCount: number,
	microphonePermission: PermissionState | null,
	cameraPermission: PermissionState | null,
): string {
	return i18n._(DEVICE_PERMISSION_SUMMARY_DESCRIPTOR, {
		inputCount,
		outputCount,
		cameraCount,
		microphonePermission: formatSupportPermission(i18n, microphonePermission),
		cameraPermission: formatSupportPermission(i18n, cameraPermission),
	});
}

export function formatSupportUpdateAvailable(i18n: I18n, version: string): string {
	return i18n._(UPDATE_AVAILABLE_DESCRIPTOR, {version});
}

export function formatSupportUpdateLastChecked(i18n: I18n, lastUpdateCheck: string): string {
	return i18n._(UPDATE_LAST_CHECKED_DESCRIPTOR, {lastUpdateCheck});
}
