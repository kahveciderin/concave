import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const filesTable = sqliteTable("files", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => usersTable.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const categoriesTable = sqliteTable("categories", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const tagsTable = sqliteTable("tags", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const todosTable = sqliteTable("todos", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  categoryId: text("categoryId").references(() => categoriesTable.id, { onDelete: "set null" }),
  imageId: text("imageId").references(() => filesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const todoTagsTable = sqliteTable("todoTags", {
  todoId: text("todoId").notNull().references(() => todosTable.id, { onDelete: "cascade" }),
  tagId: text("tagId").notNull().references(() => tagsTable.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.todoId, table.tagId] }),
]);

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
export type FileRecord = typeof filesTable.$inferSelect;
export type NewFileRecord = typeof filesTable.$inferInsert;
export type Category = typeof categoriesTable.$inferSelect;
export type NewCategory = typeof categoriesTable.$inferInsert;
export type Tag = typeof tagsTable.$inferSelect;
export type NewTag = typeof tagsTable.$inferInsert;
export type Todo = typeof todosTable.$inferSelect;
export type NewTodo = typeof todosTable.$inferInsert;
export type TodoTag = typeof todoTagsTable.$inferSelect;
export type NewTodoTag = typeof todoTagsTable.$inferInsert;
