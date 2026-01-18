import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createAdminUI } from "../../src/ui";
import {
  registerResourceSchema,
  clearSchemaRegistry,
} from "../../src/ui/schema-registry";

const testTable = sqliteTable("test_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status"),
  count: integer("count"),
});

describe("Admin UI Data Explorer", () => {
  let app: Express;
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    // Create in-memory database
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    // Create table
    sqlite.exec(`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT,
        count INTEGER
      )
    `);

    // Insert test data
    sqlite.exec(`
      INSERT INTO test_items (id, name, status, count) VALUES
        ('1', 'Item 1', 'active', 10),
        ('2', 'Item 2', 'inactive', 20),
        ('3', 'Item 3', 'active', 30)
    `);

    // Clear schema registry
    clearSchemaRegistry();

    // Create Express app
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    sqlite.close();
    clearSchemaRegistry();
  });

  describe("schema registry path normalization", () => {
    it("should find schema when path last segment matches table name", async () => {
      // This is the realistic scenario: path /api/test_items, table name test_items
      // Register schema with table name (as useResource does)
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      // Mount admin UI
      app.use("/__concave", createAdminUI({}));

      // Try to access data table using path (without leading slash, as URL normalization does)
      const response = await request(app)
        .get("/__concave/ui/data/api%2Ftest_items/table")
        .expect("Content-Type", /html/);

      // Should NOT contain "Resource not found" error
      expect(response.text).not.toContain("Resource not found");
      expect(response.text).not.toContain("is not registered");
    });

    it("should find schema when queried with table name directly", async () => {
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/test_items/table")
        .expect("Content-Type", /html/);

      expect(response.text).not.toContain("Resource not found");
    });

    it("should return data table with items when schema is found", async () => {
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/api%2Ftest_items/table")
        .expect("Content-Type", /html/);

      // Should contain table with data
      expect(response.text).toContain("Item 1");
      expect(response.text).toContain("Item 2");
      expect(response.text).toContain("Item 3");
    });

    it("should handle versioned API paths", async () => {
      // Path like /api/v1/test_items should also work - extract last segment
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/api%2Fv1%2Ftest_items/table")
        .expect("Content-Type", /html/);

      expect(response.text).not.toContain("Resource not found");
      expect(response.text).toContain("Item 1");
    });

    it("should handle path registered directly in schema registry", async () => {
      // If someone explicitly registers with path, it should still work
      registerResourceSchema("/api/items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/api%2Fitems/table")
        .expect("Content-Type", /html/);

      expect(response.text).not.toContain("Resource not found");
      expect(response.text).toContain("Item 1");
    });
  });

  describe("data explorer page", () => {
    it("should render data explorer page with resources", async () => {
      registerResourceSchema("items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data-explorer")
        .expect("Content-Type", /html/)
        .expect(200);

      expect(response.text).toContain("Data Explorer");
      expect(response.text).toContain("items");
    });

    it("should show resources list", async () => {
      registerResourceSchema("users", testTable, db, testTable.id, {});
      registerResourceSchema("posts", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/resources")
        .expect("Content-Type", /html/);

      expect(response.text).toContain("users");
      expect(response.text).toContain("posts");
    });
  });

  describe("row detail", () => {
    it("should fetch single row detail", async () => {
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/test_items/row/1")
        .expect("Content-Type", /html/);

      expect(response.text).toContain("Item 1");
      expect(response.text).toContain("active");
    });

    it("should return not found for missing row", async () => {
      registerResourceSchema("test_items", testTable, db, testTable.id, {});

      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/data/test_items/row/999")
        .expect("Content-Type", /html/);

      expect(response.text).toContain("Record not found");
    });
  });
});
