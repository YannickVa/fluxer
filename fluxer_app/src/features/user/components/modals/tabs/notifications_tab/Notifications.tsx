// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {ENABLE_NOTIFICATIONS_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {usePushSubscriptions} from '@app/features/notification/hooks/usePushSubscriptions';
import {formatQuietHoursTime, parseQuietHoursTime} from '@app/features/notification/NotificationQuietHours';
import * as NotificationUtils from '@app/features/notification/utils/NotificationUtils';
import * as PushSubscriptionService from '@app/features/platform/push/PushSubscriptionService';
import * as NotificationCommands from '@app/features/ui/commands/NotificationCommands';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import NotificationState from '@app/features/ui/state/Notification';
import {isDesktop} from '@app/features/ui/utils/NativeUtils';
import {isInstalledPwa, isPwaOnMobileOrTablet} from '@app/features/ui/utils/PwaUtils';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import styles from '@app/features/user/components/modals/tabs/notifications_tab/Notifications.module.css';
import {PushSettings} from '@app/features/user/components/modals/tabs/notifications_tab/PushSettings';
import UserSettings from '@app/features/user/state/UserSettings';
import {msg, plural} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type {FC} from 'react';

const LOADING_PUSH_SUBSCRIPTIONS_DESCRIPTOR = msg({
	message: 'Loading push subscriptions…',
	comment: 'Short label in the notifications. Keep it concise.',
});
const NO_PUSH_SUBSCRIPTIONS_REGISTERED_YET_DESCRIPTOR = msg({
	message: 'No push subscriptions registered yet.',
	comment: 'Empty-state text in the notifications.',
});
const ENABLE_DESKTOP_NOTIFICATIONS_DESCRIPTOR = msg({
	message: 'Enable desktop notifications',
	comment: 'Button or menu action label in the notifications. Keep it concise.',
});
const ENABLE_BROWSER_NOTIFICATIONS_DESCRIPTOR = msg({
	message: 'Enable browser notifications',
	comment: 'Button or menu action label in the notifications. Keep it concise.',
});
const USES_THE_OS_NOTIFICATION_CENTER_FOR_PER_CHANNEL_DESCRIPTOR = msg({
	message:
		'Uses the OS notification center. For per-channel/per-community controls, right-click a community icon and open notification settings.',
	comment: 'Label in the notifications.',
});
const GET_NOTIFIED_WHEN_YOU_RECEIVE_MESSAGES_YOU_MAY_DESCRIPTOR = msg({
	message:
		"Get notified when you receive messages. You may need to allow notifications for {productName} in your device settings. For per-channel/per-community controls, open notification settings from a community's menu.",
	comment: 'Label in the notifications.',
});
const GET_NOTIFIED_WHEN_YOU_RECEIVE_MESSAGES_YOU_MAY_2_DESCRIPTOR = msg({
	message:
		'Get notified when you receive messages. You may need to allow notifications in your browser settings. For per-channel/per-community controls, right-click a community icon and open notification settings.',
	comment: 'Label in the notifications.',
});
const ENABLE_UNREAD_MESSAGE_BADGE_DESCRIPTOR = msg({
	message: 'Enable unread message badge',
	comment: 'Button or menu action label in the notifications. Keep it concise.',
});
const PUSH_SUBSCRIPTIONS_FOR_THIS_DEVICE_DESCRIPTOR = msg({
	message: 'Push subscriptions for this device',
	comment: 'Label in the notifications.',
});
const USES_PUSH_NOTIFICATIONS_WHEN_INSTALLED_AS_A_MOBILE_DESCRIPTOR = msg({
	message:
		'{productName} uses push notifications when installed as a mobile PWA. Registering ensures the gateway can reach your device even when the app is backgrounded.',
	comment: 'Label in the notifications.',
});
const REFRESH_PUSH_SUBSCRIPTION_DESCRIPTOR = msg({
	message: 'Refresh push subscription',
	comment: 'Short label in the notifications. Keep it concise.',
});
const ENABLE_PUSH_FOR_THIS_DEVICE_DESCRIPTOR = msg({
	message: 'Enable push for this device',
	comment: 'Button or menu action label in the notifications. Keep it concise.',
});
const FORGET_SUBSCRIPTIONS_DESCRIPTOR = msg({
	message: 'Forget subscriptions',
	comment: 'Short label in the notifications. Keep it concise.',
});
const UNKNOWN_DEVICE_DESCRIPTOR = msg({
	message: 'Unknown device',
	comment: 'Short label in the notifications. Keep it concise.',
});
const QUIET_HOURS_DESCRIPTOR = msg({
	message: 'Quiet hours',
	comment: 'Notification setting that suppresses notifications during a daily local-time window.',
});
const QUIET_HOURS_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Silence notification banners and sounds on this device during a daily window. Unread indicators remain.',
	comment: 'Description of device-local notification quiet hours.',
});
const START_TIME_DESCRIPTOR = msg({
	message: 'Start time',
	comment: 'Label for the beginning of notification quiet hours.',
});
const END_TIME_DESCRIPTOR = msg({
	message: 'End time',
	comment: 'Label for the end of notification quiet hours.',
});

interface NotificationsProps {
	browserNotificationsEnabled: boolean;
	unreadMessageBadgeEnabled: boolean;
}

export const Notifications: FC<NotificationsProps> = observer(
	({browserNotificationsEnabled, unreadMessageBadgeEnabled}) => {
		const {i18n} = useLingui();
		const isPwa = isInstalledPwa();
		const isPwaMobile = isPwaOnMobileOrTablet();
		const {subscriptions, loading, refresh} = usePushSubscriptions(isPwaMobile);
		const handleToggleNotifications = (value: boolean) => {
			if (!value) {
				NotificationCommands.permissionDenied(i18n, true);
				return;
			}
			if (typeof Notification === 'undefined') {
				void NotificationUtils.requestPermission(i18n);
				return;
			}
			const permissionPromise: Promise<NotificationPermission> =
				Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
			void (async () => {
				const permission = await permissionPromise;
				NotificationUtils.handlePermissionResult(i18n, permission);
				if (permission === 'granted' && isPwaMobile) {
					await PushSubscriptionService.registerPushSubscription();
					await refresh();
				}
			})();
		};
		const handleToggleUnreadBadge = (value: boolean) => {
			NotificationCommands.toggleUnreadMessageBadge(value);
		};
		const handleAfkTimeoutChange = async (value: number) => {
			try {
				await UserSettingsCommands.update({afkTimeout: value * 60});
			} catch {}
		};
		const handleRegisterPushSubscription = () => {
			if (typeof Notification === 'undefined') return;
			const permissionPromise: Promise<NotificationPermission> =
				Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
			void (async () => {
				const permission = await permissionPromise;
				NotificationUtils.handlePermissionResult(i18n, permission);
				if (permission !== 'granted') return;
				await PushSubscriptionService.registerPushSubscription();
				await refresh();
			})();
		};
		const handleForgetPushSubscriptions = async () => {
			await PushSubscriptionService.unregisterAllPushSubscriptions();
			await refresh();
		};
		const handleQuietHoursStartChange = (value: string) => {
			const minutes = parseQuietHoursTime(value);
			if (minutes !== null) NotificationState.setQuietHoursStartMinutes(minutes);
		};
		const handleQuietHoursEndChange = (value: string) => {
			const minutes = parseQuietHoursTime(value);
			if (minutes !== null) NotificationState.setQuietHoursEndMinutes(minutes);
		};
		const pushStatusMessage = loading
			? i18n._(LOADING_PUSH_SUBSCRIPTIONS_DESCRIPTOR)
			: subscriptions.length > 0
				? plural(
						{count: subscriptions.length},
						{
							one: '# active subscription',
							other: '# active subscriptions',
						},
					)
				: i18n._(NO_PUSH_SUBSCRIPTIONS_REGISTERED_YET_DESCRIPTOR);
		return (
			<div className={styles.container} data-flx="user.notifications-tab.notifications.container">
				<div className={styles.switchesContainer} data-flx="user.notifications-tab.notifications.switches-container">
					<Switch
						label={
							isDesktop()
								? i18n._(ENABLE_DESKTOP_NOTIFICATIONS_DESCRIPTOR)
								: isPwa
									? i18n._(ENABLE_NOTIFICATIONS_DESCRIPTOR)
									: i18n._(ENABLE_BROWSER_NOTIFICATIONS_DESCRIPTOR)
						}
						description={
							isDesktop()
								? i18n._(USES_THE_OS_NOTIFICATION_CENTER_FOR_PER_CHANNEL_DESCRIPTOR)
								: isPwa
									? i18n._(GET_NOTIFIED_WHEN_YOU_RECEIVE_MESSAGES_YOU_MAY_DESCRIPTOR, {productName: PRODUCT_NAME})
									: i18n._(GET_NOTIFIED_WHEN_YOU_RECEIVE_MESSAGES_YOU_MAY_2_DESCRIPTOR)
						}
						value={browserNotificationsEnabled}
						onChange={handleToggleNotifications}
						data-flx="user.notifications-tab.notifications.switch.toggle-notifications"
					/>
					<Switch
						label={i18n._(ENABLE_UNREAD_MESSAGE_BADGE_DESCRIPTOR)}
						value={unreadMessageBadgeEnabled}
						onChange={handleToggleUnreadBadge}
						data-flx="user.notifications-tab.notifications.switch.toggle-unread-badge"
					/>
					<Switch
						label={i18n._(QUIET_HOURS_DESCRIPTOR)}
						description={i18n._(QUIET_HOURS_DESCRIPTION_DESCRIPTOR)}
						value={NotificationState.quietHoursEnabled}
						onChange={NotificationState.setQuietHoursEnabled}
					/>
					{NotificationState.quietHoursEnabled ? (
						<div className={styles.quietHoursTimes}>
							<label>
								<span>{i18n._(START_TIME_DESCRIPTOR)}</span>
								<input
									type="time"
									value={formatQuietHoursTime(NotificationState.quietHoursStartMinutes)}
									onChange={(event) => handleQuietHoursStartChange(event.target.value)}
								/>
							</label>
							<label>
								<span>{i18n._(END_TIME_DESCRIPTOR)}</span>
								<input
									type="time"
									value={formatQuietHoursTime(NotificationState.quietHoursEndMinutes)}
									onChange={(event) => handleQuietHoursEndChange(event.target.value)}
								/>
							</label>
							<p>
								<Trans>Uses this device’s local time. Matching start and end times means all day.</Trans>
							</p>
						</div>
					) : null}
				</div>
				<PushSettings
					afkTimeout={UserSettings.afkTimeout}
					onAfkTimeoutChange={handleAfkTimeoutChange}
					data-flx="user.notifications-tab.notifications.push-settings"
				/>
				{isPwaMobile && (
					<div className={styles.pushSection} data-flx="user.notifications-tab.notifications.push-section">
						<div data-flx="user.notifications-tab.notifications.div">
							<h3 className={styles.pushHeading} data-flx="user.notifications-tab.notifications.push-heading">
								{i18n._(PUSH_SUBSCRIPTIONS_FOR_THIS_DEVICE_DESCRIPTOR)}
							</h3>
							<p className={styles.pushDescription} data-flx="user.notifications-tab.notifications.push-description">
								{i18n._(USES_PUSH_NOTIFICATIONS_WHEN_INSTALLED_AS_A_MOBILE_DESCRIPTOR, {productName: PRODUCT_NAME})}
							</p>
						</div>
						<div className={styles.pushButtons} data-flx="user.notifications-tab.notifications.push-buttons">
							<button
								type="button"
								className={styles.pushButton}
								onClick={handleRegisterPushSubscription}
								data-flx="user.notifications-tab.notifications.push-button.register-push-subscription"
							>
								{subscriptions.length > 0
									? i18n._(REFRESH_PUSH_SUBSCRIPTION_DESCRIPTOR)
									: i18n._(ENABLE_PUSH_FOR_THIS_DEVICE_DESCRIPTOR)}
							</button>
							<button
								type="button"
								className={clsx(styles.pushButton, styles.pushButtonSecondary)}
								onClick={handleForgetPushSubscriptions}
								disabled={subscriptions.length === 0}
								data-flx="user.notifications-tab.notifications.push-button.forget-push-subscriptions"
							>
								{i18n._(FORGET_SUBSCRIPTIONS_DESCRIPTOR)}
							</button>
						</div>
						<p className={styles.pushStatus} data-flx="user.notifications-tab.notifications.push-status">
							{pushStatusMessage}
						</p>
						{subscriptions.length > 0 && (
							<ul className={styles.pushList} data-flx="user.notifications-tab.notifications.push-list">
								{subscriptions.map((subscription) => (
									<li
										key={subscription.subscription_id}
										className={styles.pushListItem}
										data-flx="user.notifications-tab.notifications.push-list-item"
									>
										<span data-flx="user.notifications-tab.notifications.span">
											{subscription.user_agent ?? i18n._(UNKNOWN_DEVICE_DESCRIPTOR)}
										</span>
										<span data-flx="user.notifications-tab.notifications.span--2">{subscription.subscription_id}</span>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		);
	},
);
