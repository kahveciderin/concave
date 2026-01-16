import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export const authUsersTable = sqliteTable("auth_users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp" }),
  name: text("name"),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const authSessionsTable = sqliteTable(
  "auth_sessions",
  {
    sessionToken: text("sessionToken").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => authUsersTable.id, { onDelete: "cascade" }),
    expires: integer("expires", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userIdIdx: index("session_userId_idx").on(table.userId),
    expiresIdx: index("session_expires_idx").on(table.expires),
  })
);

export const authAccountsTable = sqliteTable(
  "auth_accounts",
  {
    userId: text("userId")
      .notNull()
      .references(() => authUsersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => ({
    compoundKey: primaryKey({
      columns: [table.provider, table.providerAccountId],
    }),
    userIdIdx: index("account_userId_idx").on(table.userId),
  })
);

export const authVerificationTokensTable = sqliteTable(
  "auth_verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    compoundKey: primaryKey({
      columns: [table.identifier, table.token],
    }),
  })
);

export const authApiKeysTable = sqliteTable(
  "auth_api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => authUsersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("keyHash").notNull(),
    keyPrefix: text("keyPrefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expiresAt", { mode: "timestamp" }),
    lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
    revokedAt: integer("revokedAt", { mode: "timestamp" }),
  },
  (table) => ({
    userIdIdx: index("api_key_userId_idx").on(table.userId),
    keyPrefixIdx: index("api_key_prefix_idx").on(table.keyPrefix),
  })
);

export const changelogTable = sqliteTable(
  "changelog",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    resource: text("resource").notNull(),
    type: text("type").notNull().$type<"create" | "update" | "delete">(),
    objectId: text("objectId").notNull(),
    object: text("object", { mode: "json" }).$type<Record<string, unknown>>(),
    previousObject: text("previousObject", { mode: "json" }).$type<Record<string, unknown>>(),
    timestamp: integer("timestamp", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    userId: text("userId"),
  },
  (table) => ({
    resourceIdx: index("changelog_resource_idx").on(table.resource),
    timestampIdx: index("changelog_timestamp_idx").on(table.timestamp),
    resourceSeqIdx: index("changelog_resource_seq_idx").on(
      table.resource,
      table.seq
    ),
  })
);

export const rateLimitTable = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    windowStart: integer("windowStart", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    expiresIdx: index("rate_limit_expires_idx").on(table.expiresAt),
  })
);

export type AuthUser = typeof authUsersTable.$inferSelect;
export type NewAuthUser = typeof authUsersTable.$inferInsert;

export type AuthSession = typeof authSessionsTable.$inferSelect;
export type NewAuthSession = typeof authSessionsTable.$inferInsert;

export type AuthAccount = typeof authAccountsTable.$inferSelect;
export type NewAuthAccount = typeof authAccountsTable.$inferInsert;

export type AuthApiKey = typeof authApiKeysTable.$inferSelect;
export type NewAuthApiKey = typeof authApiKeysTable.$inferInsert;

export type ChangelogRow = typeof changelogTable.$inferSelect;
export type NewChangelogRow = typeof changelogTable.$inferInsert;
