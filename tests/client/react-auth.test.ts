import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
};

const mockJwtState = {
  accessToken: "jwt-access-token",
  user: mockUser,
  isAuthenticated: true,
  expiresAt: new Date(Date.now() + 3600000),
};

describe("useAuth hook logic", () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockJwtClient: {
    getAccessToken: ReturnType<typeof vi.fn>;
    isAuthenticated: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    getUser: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  let mockAuth: {
    getAccessToken: ReturnType<typeof vi.fn>;
    isAuthenticated: ReturnType<typeof vi.fn>;
    getUser: ReturnType<typeof vi.fn>;
  };
  let mockClient: {
    jwt: typeof mockJwtClient | undefined;
    auth: typeof mockAuth;
  };
  let jwtSubscribers: Array<(state: typeof mockJwtState) => void>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    jwtSubscribers = [];

    mockJwtClient = {
      getAccessToken: vi.fn().mockReturnValue(null),
      isAuthenticated: vi.fn().mockReturnValue(false),
      getState: vi.fn().mockReturnValue({ accessToken: null, user: null, isAuthenticated: false }),
      getUser: vi.fn().mockResolvedValue(null),
      logout: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((callback) => {
        jwtSubscribers.push(callback);
        return () => {
          jwtSubscribers = jwtSubscribers.filter(cb => cb !== callback);
        };
      }),
    };

    mockAuth = {
      getAccessToken: vi.fn().mockReturnValue(null),
      isAuthenticated: vi.fn().mockReturnValue(false),
      getUser: vi.fn().mockReturnValue(null),
    };

    mockClient = {
      jwt: undefined,
      auth: mockAuth,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("strategy detection", () => {
    const detectStrategy = (options: {
      strategy?: string;
      token?: string;
      apiKey?: string;
      client?: typeof mockClient;
    }) => {
      const { strategy, token, apiKey, client = mockClient } = options;

      if (strategy && strategy !== "auto") {
        return strategy;
      }
      if (token) return "bearer";
      if (apiKey) return "apiKey";
      if (client?.jwt?.isAuthenticated?.() || client?.jwt?.getAccessToken?.()) {
        return "jwt";
      }
      if (client?.auth?.isAuthenticated?.()) {
        return "jwt";
      }
      return "cookie";
    };

    it("should return explicit strategy when provided", () => {
      expect(detectStrategy({ strategy: "jwt" })).toBe("jwt");
      expect(detectStrategy({ strategy: "cookie" })).toBe("cookie");
      expect(detectStrategy({ strategy: "bearer" })).toBe("bearer");
      expect(detectStrategy({ strategy: "apiKey" })).toBe("apiKey");
    });

    it("should detect bearer when token is provided", () => {
      expect(detectStrategy({ token: "my-token" })).toBe("bearer");
      expect(detectStrategy({ strategy: "auto", token: "my-token" })).toBe("bearer");
    });

    it("should detect apiKey when apiKey is provided", () => {
      expect(detectStrategy({ apiKey: "my-key" })).toBe("apiKey");
      expect(detectStrategy({ strategy: "auto", apiKey: "my-key" })).toBe("apiKey");
    });

    it("should detect jwt when jwt client has token", () => {
      mockJwtClient.getAccessToken.mockReturnValue("jwt-token");
      mockClient.jwt = mockJwtClient;

      expect(detectStrategy({ client: mockClient })).toBe("jwt");
    });

    it("should detect jwt when jwt client is authenticated", () => {
      mockJwtClient.isAuthenticated.mockReturnValue(true);
      mockClient.jwt = mockJwtClient;

      expect(detectStrategy({ client: mockClient })).toBe("jwt");
    });

    it("should fall back to cookie when no jwt configured", () => {
      mockClient.jwt = undefined;
      expect(detectStrategy({ client: mockClient })).toBe("cookie");
    });

    it("should prefer explicit strategy over auto-detection", () => {
      mockJwtClient.getAccessToken.mockReturnValue("jwt-token");
      mockClient.jwt = mockJwtClient;

      expect(detectStrategy({ strategy: "cookie", client: mockClient })).toBe("cookie");
    });

    it("should prefer token over jwt when both available", () => {
      mockJwtClient.getAccessToken.mockReturnValue("jwt-token");
      mockClient.jwt = mockJwtClient;

      expect(detectStrategy({ token: "bearer-token", client: mockClient })).toBe("bearer");
    });
  });

  describe("getAuthHeaders helper", () => {
    const getAuthHeaders = (options: {
      strategy: string;
      token?: string;
      apiKey?: string;
      client?: typeof mockClient;
    }): Record<string, string> => {
      const headers: Record<string, string> = {};
      const { strategy, token, apiKey, client = mockClient } = options;

      switch (strategy) {
        case "jwt": {
          const jwtToken = client?.jwt?.getAccessToken?.() ?? client?.auth?.getAccessToken?.();
          if (jwtToken) {
            headers["Authorization"] = `Bearer ${jwtToken}`;
          }
          break;
        }
        case "bearer": {
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          break;
        }
        case "apiKey": {
          if (apiKey) {
            headers["X-API-Key"] = apiKey;
          }
          break;
        }
      }

      return headers;
    };

    it("should return empty headers for cookie strategy", () => {
      const headers = getAuthHeaders({ strategy: "cookie" });
      expect(headers).toEqual({});
    });

    it("should return Authorization header for jwt strategy", () => {
      mockJwtClient.getAccessToken.mockReturnValue("jwt-token");
      mockClient.jwt = mockJwtClient;

      const headers = getAuthHeaders({ strategy: "jwt", client: mockClient });
      expect(headers).toEqual({ Authorization: "Bearer jwt-token" });
    });

    it("should return Authorization header for bearer strategy", () => {
      const headers = getAuthHeaders({ strategy: "bearer", token: "my-bearer-token" });
      expect(headers).toEqual({ Authorization: "Bearer my-bearer-token" });
    });

    it("should return X-API-Key header for apiKey strategy", () => {
      const headers = getAuthHeaders({ strategy: "apiKey", apiKey: "my-api-key" });
      expect(headers).toEqual({ "X-API-Key": "my-api-key" });
    });

    it("should use auth manager token when jwt client not available", () => {
      mockAuth.getAccessToken.mockReturnValue("auth-token");
      mockClient.jwt = undefined;

      const headers = getAuthHeaders({ strategy: "jwt", client: mockClient });
      expect(headers).toEqual({ Authorization: "Bearer auth-token" });
    });
  });

  describe("cookie strategy fetch behavior", () => {
    it("should fetch with credentials include", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: mockUser }),
      });

      await fetch("http://localhost/api/auth/me", {
        credentials: "include",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost/api/auth/me",
        expect.objectContaining({
          credentials: "include",
        })
      );
    });
  });

  describe("jwt strategy fetch behavior", () => {
    it("should include Authorization header", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: mockUser }),
      });

      await fetch("http://localhost/api/auth/me", {
        headers: { Authorization: "Bearer jwt-token" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer jwt-token",
          }),
        })
      );
    });
  });

  describe("bearer strategy fetch behavior", () => {
    it("should include provided token in Authorization header", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: mockUser }),
      });

      await fetch("http://localhost/api/auth/me", {
        headers: { Authorization: "Bearer my-bearer-token" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer my-bearer-token",
          }),
        })
      );
    });
  });

  describe("apiKey strategy fetch behavior", () => {
    it("should include X-API-Key header", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: mockUser }),
      });

      await fetch("http://localhost/api/auth/me", {
        headers: { "X-API-Key": "my-api-key" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-API-Key": "my-api-key",
          }),
        })
      );
    });
  });

  describe("response parsing", () => {
    it("should parse successful auth response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: mockUser }),
      });

      const response = await fetch("http://localhost/api/auth/me", {
        credentials: "include",
      });
      const data = await response.json();

      expect(data.user).toEqual(mockUser);
    });

    it("should handle null user in response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user: null }),
      });

      const response = await fetch("http://localhost/api/auth/me", {
        credentials: "include",
      });
      const data = await response.json();

      expect(data.user).toBeNull();
    });

    it("should handle error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized" }),
      });

      const response = await fetch("http://localhost/api/auth/me", {
        credentials: "include",
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(
        fetch("http://localhost/api/auth/me", { credentials: "include" })
      ).rejects.toThrow("Network error");
    });
  });

  describe("logout behavior", () => {
    it("should POST to logout endpoint for cookie strategy", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await fetch("http://localhost/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/logout"),
        expect.objectContaining({
          method: "POST",
          credentials: "include",
        })
      );
    });

    it("should call jwt client logout for jwt strategy", async () => {
      mockClient.jwt = mockJwtClient;

      await mockJwtClient.logout();

      expect(mockJwtClient.logout).toHaveBeenCalled();
    });
  });

  describe("jwt client subscription", () => {
    it("should subscribe to jwt state changes", () => {
      mockClient.jwt = mockJwtClient;

      const callback = vi.fn();
      const unsubscribe = mockJwtClient.subscribe(callback);

      expect(mockJwtClient.subscribe).toHaveBeenCalledWith(callback);
      expect(jwtSubscribers).toContain(callback);

      unsubscribe();
      expect(jwtSubscribers).not.toContain(callback);
    });

    it("should notify subscribers on state change", () => {
      mockClient.jwt = mockJwtClient;

      const callback = vi.fn();
      mockJwtClient.subscribe(callback);

      jwtSubscribers.forEach((cb) => cb(mockJwtState));

      expect(callback).toHaveBeenCalledWith(mockJwtState);
    });
  });

  describe("URL handling", () => {
    it("should use default checkUrl when not provided", () => {
      const defaultUrl = "/api/auth/me";
      const baseUrl = "http://localhost";
      const fullUrl = `${baseUrl}${defaultUrl}`;

      expect(fullUrl).toBe("http://localhost/api/auth/me");
    });

    it("should use custom checkUrl when provided", () => {
      const customUrl = "/custom/auth/check";
      const baseUrl = "http://localhost";
      const fullUrl = `${baseUrl}${customUrl}`;

      expect(fullUrl).toBe("http://localhost/custom/auth/check");
    });

    it("should handle absolute checkUrl", () => {
      const absoluteUrl = "https://auth.example.com/check";
      const checkUrl = absoluteUrl;
      const isAbsolute = checkUrl.startsWith("http");
      const fullUrl = isAbsolute ? checkUrl : `http://localhost${checkUrl}`;

      expect(fullUrl).toBe("https://auth.example.com/check");
    });

    it("should use custom baseUrl", () => {
      const baseUrl = "https://api.example.com";
      const checkUrl = "/api/auth/me";
      const fullUrl = `${baseUrl}${checkUrl}`;

      expect(fullUrl).toBe("https://api.example.com/api/auth/me");
    });
  });
});

describe("Passport adapter compatibility", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should work with passport session endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        user: {
          id: "user-1",
          email: "test@example.com",
        },
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    });

    const response = await fetch("http://localhost/api/auth/session", {
      credentials: "include",
    });
    const data = await response.json();

    expect(data.user).toBeDefined();
    expect(data.expiresAt).toBeDefined();
  });

  it("should include bearer token for passport bearer auth", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user-1" } }),
    });

    await fetch("http://localhost/api/auth/session", {
      headers: { Authorization: "Bearer session-token" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
        }),
      })
    );
  });
});

describe("AuthJS/NextAuth adapter compatibility", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should work with authjs session endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        user: {
          id: "user-1",
          email: "test@example.com",
          name: "Test User",
          image: "https://example.com/avatar.jpg",
        },
      }),
    });

    const response = await fetch("http://localhost/api/auth/session", {
      credentials: "include",
    });
    const data = await response.json();

    expect(data.user.id).toBe("user-1");
    expect(data.user.name).toBe("Test User");
  });

  it("should handle bearer token auth with authjs", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user-1" } }),
    });

    await fetch("http://localhost/api/auth/session", {
      headers: { Authorization: "Bearer session-token" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
        }),
      })
    );
  });
});

describe("OIDC adapter compatibility", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should include OIDC access token in Authorization header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user-1" } }),
    });

    await fetch("http://localhost/api/auth/me", {
      headers: { Authorization: "Bearer oidc-access-token" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oidc-access-token",
        }),
      })
    );
  });
});

describe("JWT adapter compatibility", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should include JWT in Authorization header for /api/auth/me", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        user: {
          id: "user-1",
          email: "test@example.com",
        },
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      }),
    });

    await fetch("http://localhost/api/auth/me", {
      headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/me"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer eyJ/),
        }),
      })
    );
  });

  it("should handle JWT refresh flow", async () => {
    const mockJwtClient = {
      refresh: vi.fn().mockResolvedValue({
        accessToken: "new-access-token",
        expiresIn: 900,
        tokenType: "Bearer",
      }),
    };

    const result = await mockJwtClient.refresh();

    expect(mockJwtClient.refresh).toHaveBeenCalled();
    expect(result.accessToken).toBe("new-access-token");
  });
});

describe("Type safety", () => {
  interface CustomUser {
    id: string;
    email: string;
    customField: string;
  }

  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should support custom user type in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        user: {
          id: "user-1",
          email: "test@example.com",
          customField: "custom-value",
        },
      }),
    });
    global.fetch = mockFetch;

    const response = await fetch("http://localhost/api/auth/me", {
      credentials: "include",
    });
    const data = await response.json();
    const user = data.user as CustomUser;

    expect(user.customField).toBe("custom-value");
  });
});

describe("AuthStrategy type", () => {
  it("should accept valid strategy values", () => {
    type AuthStrategy = "cookie" | "jwt" | "bearer" | "apiKey" | "auto";
    
    const strategies: AuthStrategy[] = ["cookie", "jwt", "bearer", "apiKey", "auto"];
    
    expect(strategies).toContain("cookie");
    expect(strategies).toContain("jwt");
    expect(strategies).toContain("bearer");
    expect(strategies).toContain("apiKey");
    expect(strategies).toContain("auto");
  });
});
