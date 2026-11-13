/** A notification occurrence owned by one authenticated account. */
export type AccountNotification = {
  id: string;
  kind: "completion" | "failure" | "help" | "takeover";
  /** Remember the occurrence without alerting, so waking a chat cannot replay it. */
  suppressed?: boolean;
  title: string;
  body: string;
  botId: string;
  groupId?: string;
  threadId: string;
  spaceId: string;
};

export type SavedAccountSummary = {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  image: string | null;
  unread: number;
  notifications: AccountNotification[];
};

export type AccountSessions = {
  serverOrigin?: string;
  activeUserId: string | null;
  accounts: SavedAccountSummary[];
};
