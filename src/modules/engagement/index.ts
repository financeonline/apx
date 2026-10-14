/** `modules/engagement` — Team/Client Management, in-app (Agreement §4; ADR-144). */
export {
  ENGAGEMENT_STATUS_LABELS,
  addActionComment,
  commentEngagementItem,
  createEngagementItem,
  getEngagementItem,
  listActionComments,
  listEngagementItems,
  listNotifications,
  markNotificationsRead,
  unreadCount,
  updateEngagementStatus,
  type CommentView,
  type EngagementEventView,
  type EngagementItemView,
  type EngagementKind,
  type EngagementStatus,
  type NotificationView,
} from './services';
export { NOTIFICATION_KIND_PERMISSION, notificationHref, readableNotificationKinds } from './domain/notifications';
