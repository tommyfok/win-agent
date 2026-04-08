/**
 * 任务状态枚举，与数据库 tasks.status 字段值保持一致。
 * 所有代码中对任务状态的比较应使用此枚举，避免魔法字符串。
 */
export const TaskStatus = {
  PendingDev: "pending_dev",
  InDev: "in_dev",
  Done: "done",
  Rejected: "rejected",
  Cancelled: "cancelled",
  Paused: "paused",
  Blocked: "blocked",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * 消息状态枚举，与数据库 messages.status 字段值保持一致。
 */
export const MessageStatus = {
  Unread: "unread",
  Read: "read",
  Deferred: "deferred",
} as const;

export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];
