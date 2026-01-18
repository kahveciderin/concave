import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import { Server } from "http";
import request from "supertest";
import { createAdminUI, AdminUIConfig } from "../src/ui/middleware";

const injectTestUser = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: "test-user", email: "test@test.com", roles: ["admin"] };
  next();
};

describe("Admin UI Tests", () => {
  let app: Express;
  let server: Server;

  const mockUsers = [
    { id: "1", email: "user1@test.com", name: "User 1" },
    { id: "2", email: "user2@test.com", name: "User 2" },
  ];

  const mockSessions = [
    { id: "sess-1", userId: "1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { id: "sess-2", userId: "2", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
  ];

  const config: AdminUIConfig = {
    title: "Test Admin",
    userManager: {
      listUsers: async (limit = 50, offset = 0) => ({
        users: mockUsers.slice(offset, offset + limit),
        total: mockUsers.length,
      }),
      getUser: async (id) => mockUsers.find(u => u.id === id) || null,
      createUser: async (data) => {
        const newUser = { id: String(mockUsers.length + 1), ...data };
        mockUsers.push(newUser);
        return newUser;
      },
      updateUser: async (id, data) => {
        const user = mockUsers.find(u => u.id === id);
        if (!user) throw new Error("User not found");
        Object.assign(user, data);
        return user;
      },
      deleteUser: async (id) => {
        const idx = mockUsers.findIndex(u => u.id === id);
        if (idx >= 0) mockUsers.splice(idx, 1);
      },
    },
    sessionManager: {
      listSessions: async () => mockSessions,
      getSessionsByUser: async (userId) => mockSessions.filter(s => s.userId === userId),
      createSession: async (userId, expiresIn = 86400) => ({
        token: `token-${Date.now()}`,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      }),
      revokeSession: async (sessionId) => {
        const idx = mockSessions.findIndex(s => s.id === sessionId);
        if (idx >= 0) mockSessions.splice(idx, 1);
      },
      revokeAllUserSessions: async (userId) => {
        const count = mockSessions.filter(s => s.userId === userId).length;
        mockSessions.splice(0, mockSessions.length, ...mockSessions.filter(s => s.userId !== userId));
        return count;
      },
    },
    dataExplorer: { enabled: true },
    kvInspector: { enabled: true },
    security: { mode: "development", auth: { disabled: true } },
  };

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(injectTestUser);
    app.use("/__concave", createAdminUI(config));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("Full Page Routes", () => {
    it("should serve dashboard page", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain("Dashboard");
      expect(res.text).toContain("<!DOCTYPE html>");
      expect(res.text).toContain("htmx");
    });

    it("should serve resources page", async () => {
      const res = await request(app).get("/__concave/ui/resources").expect(200);
      expect(res.text).toContain("Resources");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve data explorer page", async () => {
      const res = await request(app).get("/__concave/ui/data-explorer").expect(200);
      expect(res.text).toContain("Data Explorer");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve requests page", async () => {
      const res = await request(app).get("/__concave/ui/requests").expect(200);
      expect(res.text).toContain("Requests");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve errors page", async () => {
      const res = await request(app).get("/__concave/ui/errors").expect(200);
      expect(res.text).toContain("Errors");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve users page", async () => {
      const res = await request(app).get("/__concave/ui/users").expect(200);
      expect(res.text).toContain("Users");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve sessions page", async () => {
      const res = await request(app).get("/__concave/ui/sessions").expect(200);
      expect(res.text).toContain("Sessions");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve subscriptions page", async () => {
      const res = await request(app).get("/__concave/ui/subscriptions").expect(200);
      expect(res.text).toContain("Subscriptions");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve changelog page", async () => {
      const res = await request(app).get("/__concave/ui/changelog").expect(200);
      expect(res.text).toContain("Changelog");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve tasks page", async () => {
      const res = await request(app).get("/__concave/ui/tasks").expect(200);
      expect(res.text).toContain("Task Queue");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve kv-inspector page", async () => {
      const res = await request(app).get("/__concave/ui/kv-inspector").expect(200);
      expect(res.text).toContain("KV Inspector");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve admin-audit page", async () => {
      const res = await request(app).get("/__concave/ui/admin-audit").expect(200);
      expect(res.text).toContain("Admin Audit");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve filter-tester page", async () => {
      const res = await request(app).get("/__concave/ui/filter-tester").expect(200);
      expect(res.text).toContain("Filter Tester");
      expect(res.text).toContain("<!DOCTYPE html>");
    });

    it("should serve api-explorer page", async () => {
      const res = await request(app).get("/__concave/ui/api-explorer").expect(200);
      expect(res.text).toContain("API Explorer");
      expect(res.text).toContain("<!DOCTYPE html>");
    });
  });

  describe("HTMX Partial Routes", () => {
    it("should return content fragment for HTMX requests", async () => {
      const res = await request(app)
        .get("/__concave/ui/resources")
        .set("HX-Request", "true")
        .expect(200);

      expect(res.text).toContain("Resources");
      expect(res.text).not.toContain("<!DOCTYPE html>");
    });

    it("should return empty for /ui/empty", async () => {
      const res = await request(app).get("/__concave/ui/empty").expect(200);
      expect(res.text).toBe("");
    });

    it("should return request list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/requests/list")
        .expect(200);
      expect(res.text).toContain("card");
    });

    it("should return users list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/users/list")
        .expect(200);
      expect(res.text).toContain("user1@test.com");
    });

    it("should return sessions list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/sessions/list")
        .expect(200);
      expect(res.text).toContain("sess-1");
    });

    it("should return subscriptions list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/subscriptions/list")
        .expect(200);
      expect(res.text).toBeDefined();
    });

    it("should return changelog list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/changelog/list")
        .expect(200);
      expect(res.text).toBeDefined();
    });

    it("should return audit list partial", async () => {
      const res = await request(app)
        .get("/__concave/ui/audit/list")
        .expect(200);
      expect(res.text).toBeDefined();
    });
  });

  describe("API Routes", () => {
    describe("User Management", () => {
      it("should list users", async () => {
        const res = await request(app).get("/__concave/api/users").expect(200);
        expect(res.body.users).toBeDefined();
        expect(res.body.total).toBe(2);
        expect(res.body.enabled).toBe(true);
      });

      it("should get single user", async () => {
        const res = await request(app).get("/__concave/api/users/1").expect(200);
        expect(res.body.user.email).toBe("user1@test.com");
      });

      it("should return 404 for non-existent user", async () => {
        await request(app).get("/__concave/api/users/999").expect(404);
      });

      it("should create user", async () => {
        const res = await request(app)
          .post("/__concave/api/users")
          .send({ email: "new@test.com", name: "New User" })
          .expect(201);
        expect(res.body.user.email).toBe("new@test.com");
      });

      it("should update user", async () => {
        const res = await request(app)
          .patch("/__concave/api/users/1")
          .send({ name: "Updated Name" })
          .expect(200);
        expect(res.body.user.name).toBe("Updated Name");
      });

      it("should delete user", async () => {
        const initialCount = mockUsers.length;
        await request(app).delete("/__concave/api/users/1").expect(204);
        expect(mockUsers.length).toBe(initialCount - 1);
      });
    });

    describe("Session Management", () => {
      it("should list sessions", async () => {
        const res = await request(app).get("/__concave/api/sessions").expect(200);
        expect(res.body.sessions).toBeDefined();
        expect(res.body.enabled).toBe(true);
      });

      it("should get sessions by user", async () => {
        const res = await request(app).get("/__concave/api/sessions/user/2").expect(200);
        expect(res.body.sessions).toBeDefined();
      });

      it("should create session", async () => {
        const res = await request(app)
          .post("/__concave/api/sessions")
          .send({ userId: "2", expiresIn: 3600 })
          .expect(201);
        expect(res.body.session.token).toBeDefined();
        expect(res.body.session.expiresAt).toBeDefined();
      });

      it("should require userId for session creation", async () => {
        await request(app)
          .post("/__concave/api/sessions")
          .send({})
          .expect(400);
      });

      it("should revoke session", async () => {
        await request(app).delete("/__concave/api/sessions/sess-2").expect(204);
      });

      it("should revoke all user sessions", async () => {
        const res = await request(app)
          .delete("/__concave/api/sessions/user/2")
          .expect(200);
        expect(res.body.revokedCount).toBeDefined();
      });
    });

    describe("Resources API", () => {
      it("should return resources list", async () => {
        const res = await request(app).get("/__concave/api/resources").expect(200);
        expect(res.body.resources).toBeDefined();
        expect(Array.isArray(res.body.resources)).toBe(true);
      });
    });

    describe("Environment API", () => {
      it("should return environment info", async () => {
        const res = await request(app).get("/__concave/api/environment").expect(200);
        expect(res.body.mode).toBe("development");
        expect(res.body.features).toBeDefined();
        expect(res.body.features.dataExplorer).toBe(true);
        expect(res.body.features.kvInspector).toBe(true);
      });
    });

    describe("Admin Audit API", () => {
      it("should return audit log", async () => {
        const res = await request(app).get("/__concave/api/admin-audit").expect(200);
        expect(res.body.entries).toBeDefined();
        expect(res.body.mode).toBe("development");
      });

      it("should export audit log as JSON", async () => {
        const res = await request(app)
          .get("/__concave/api/admin-audit/export?format=json")
          .expect(200);
        expect(res.headers["content-type"]).toContain("application/json");
      });

      it("should export audit log as CSV", async () => {
        const res = await request(app)
          .get("/__concave/api/admin-audit/export?format=csv")
          .expect(200);
        expect(res.headers["content-type"]).toContain("text/csv");
      });
    });

    describe("Problem Details", () => {
      it("should return problem documentation", async () => {
        const res = await request(app).get("/__concave/problems/not-found").expect(200);
        expect(res.body.title).toBe("Resource Not Found");
        expect(res.body.description).toBeDefined();
        expect(res.body.solutions).toBeDefined();
      });

      it("should return unknown error for invalid type", async () => {
        const res = await request(app).get("/__concave/problems/invalid-type").expect(200);
        expect(res.body.title).toBe("Unknown Error");
      });
    });
  });

  describe("Navigation", () => {
    it("should have correct active class for dashboard", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toMatch(/class="nav-item[^"]*active[^"]*"[^>]*href="[^"]*\/ui"/);
    });

    it("should have correct active class for resources", async () => {
      const res = await request(app).get("/__concave/ui/resources").expect(200);
      expect(res.text).toMatch(/class="nav-item[^"]*active[^"]*"[^>]*href="[^"]*\/ui\/resources"/);
    });

    it("should include all navigation sections", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain("Overview");
      expect(res.text).toContain("Data");
      expect(res.text).toContain("Tools");
      expect(res.text).toContain("System");
    });

    it("should include all navigation items", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain("Dashboard");
      expect(res.text).toContain("Resources");
      expect(res.text).toContain("Requests");
      expect(res.text).toContain("Errors");
      expect(res.text).toContain("Data Explorer");
      expect(res.text).toContain("Admin Audit");
      expect(res.text).toContain("Filter Tester");
      expect(res.text).toContain("Subscriptions");
      expect(res.text).toContain("Changelog");
      expect(res.text).toContain("API Explorer");
      expect(res.text).toContain("Users");
      expect(res.text).toContain("Sessions");
      expect(res.text).toContain("Task Queue");
      expect(res.text).toContain("KV Inspector");
    });
  });

  describe("Theme Support", () => {
    it("should include theme toggle script", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain("toggleTheme");
      expect(res.text).toContain("data-theme");
    });

    it("should include dark mode CSS variables", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain('[data-theme="dark"]');
    });
  });

  describe("Environment Badge", () => {
    it("should show DEV badge in development mode", async () => {
      const res = await request(app).get("/__concave/ui").expect(200);
      expect(res.text).toContain("DEV");
      expect(res.text).toContain("env-dev");
    });
  });
});

describe("Admin UI Without Managers", () => {
  let app: Express;
  let server: Server;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use("/__concave", createAdminUI({}));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("should return empty users when no userManager", async () => {
    const res = await request(app).get("/__concave/api/users").expect(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.enabled).toBe(false);
  });

  it("should return 501 for user operations without userManager", async () => {
    await request(app).get("/__concave/api/users/1").expect(501);
    await request(app).post("/__concave/api/users").send({}).expect(501);
    await request(app).patch("/__concave/api/users/1").send({}).expect(501);
    await request(app).delete("/__concave/api/users/1").expect(501);
  });

  it("should return empty sessions when no sessionManager", async () => {
    const res = await request(app).get("/__concave/api/sessions").expect(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.enabled).toBe(false);
  });

  it("should return 501 for session operations without sessionManager", async () => {
    await request(app).get("/__concave/api/sessions/user/1").expect(501);
    await request(app).post("/__concave/api/sessions").send({}).expect(501);
    await request(app).delete("/__concave/api/sessions/1").expect(501);
    await request(app).delete("/__concave/api/sessions/user/1").expect(501);
  });

  it("should still serve UI pages", async () => {
    const res = await request(app).get("/__concave/ui").expect(200);
    expect(res.text).toContain("Dashboard");
  });

  it("should show disabled KV inspector when not configured", async () => {
    const res = await request(app).get("/__concave/ui/kv-inspector").expect(200);
    expect(res.text).toContain("KV Inspector Disabled");
  });
});
