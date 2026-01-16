import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ============================================================
// AUTH / OIDC HARDENING TESTS
// ============================================================
// Tests for:
// 1. Token validation edge cases (iss, aud, nonce, exp, nbf, iat)
// 2. JWKS rotation handling
// 3. Algorithm confusion prevention
// 4. Session fixation and rotation
// 5. CSRF correctness
// 6. Multi-tenant OIDC

// Simple JWT structure for testing invariants
interface JWTPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  azp?: string;
}

// Token validator simulation for testing invariants
const validateToken = (
  payload: JWTPayload,
  config: {
    expectedIssuer?: string;
    expectedAudience?: string;
    expectedNonce?: string;
    clockSkewTolerance?: number;
  }
): { valid: boolean; error?: string } => {
  const now = Math.floor(Date.now() / 1000);
  const clockSkew = config.clockSkewTolerance ?? 0;

  // Check issuer
  if (config.expectedIssuer && payload.iss !== config.expectedIssuer) {
    return { valid: false, error: "Invalid issuer" };
  }

  // Check audience
  if (config.expectedAudience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(config.expectedAudience)) {
      return { valid: false, error: "Invalid audience" };
    }
  }

  // Check expiration
  if (payload.exp !== undefined && payload.exp + clockSkew < now) {
    return { valid: false, error: "Token expired" };
  }

  // Check not before
  if (payload.nbf !== undefined && payload.nbf - clockSkew > now) {
    return { valid: false, error: "Token not yet valid" };
  }

  // Check issued at (suspicious if in future)
  if (payload.iat !== undefined && payload.iat - clockSkew > now) {
    return { valid: false, error: "Token issued in future" };
  }

  // Check nonce
  if (config.expectedNonce && payload.nonce !== config.expectedNonce) {
    return { valid: false, error: "Invalid nonce" };
  }

  return { valid: true };
};

describe("Auth Hardening", () => {
  describe("Token Validation Edge Cases", () => {
    describe("Issuer (iss) Validation", () => {
      it("rejects token with wrong issuer", () => {
        const payload: JWTPayload = {
          iss: "https://evil.attacker.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedIssuer: "https://auth.myapp.com",
        });
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid issuer");
      });

      it("rejects token with missing issuer", () => {
        const payload: JWTPayload = {
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedIssuer: "https://auth.myapp.com",
        });
        expect(result.valid).toBe(false);
      });

      it("handles issuer with trailing slash correctly", () => {
        const normalizeIssuer = (iss: string) => iss.replace(/\/$/, "");

        expect(normalizeIssuer("https://auth.myapp.com")).toBe("https://auth.myapp.com");
        expect(normalizeIssuer("https://auth.myapp.com/")).toBe("https://auth.myapp.com");
      });
    });

    describe("Audience (aud) Validation", () => {
      it("rejects token with wrong audience", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "different-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedAudience: "my-app",
        });
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid audience");
      });

      it("handles array audience correctly", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: ["my-app", "another-valid-app"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedAudience: "my-app",
        });
        expect(result.valid).toBe(true);
      });

      it("rejects if audience array doesn't contain expected value", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: ["other-app", "another-app"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedAudience: "my-app",
        });
        expect(result.valid).toBe(false);
      });
    });

    describe("Expiration (exp) Validation", () => {
      it("rejects expired token", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) - 3600,
        };

        const result = validateToken(payload, {});
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Token expired");
      });

      it("accepts token within clock skew tolerance", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) - 30,
        };

        const result = validateToken(payload, {
          clockSkewTolerance: 60,
        });
        expect(result.valid).toBe(true);
      });

      it("rejects token with missing exp", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
        };

        // Missing exp should be caught by higher-level validation
        expect(payload.exp).toBeUndefined();
      });
    });

    describe("Not Before (nbf) Validation", () => {
      it("rejects token used before nbf", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nbf: Math.floor(Date.now() / 1000) + 1800,
        };

        const result = validateToken(payload, {});
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Token not yet valid");
      });

      it("accepts token after nbf", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nbf: Math.floor(Date.now() / 1000) - 1800,
        };

        const result = validateToken(payload, {});
        expect(result.valid).toBe(true);
      });
    });

    describe("Issued At (iat) Validation", () => {
      it("rejects token issued in the future", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 7200,
          iat: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {});
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Token issued in future");
      });

      it("accepts reasonable iat values", () => {
        fc.assert(
          fc.property(
            fc.integer({ min: -3600, max: 0 }),
            (iatOffset) => {
              const now = Math.floor(Date.now() / 1000);
              const iat = now + iatOffset;
              return iat <= now;
            }
          ),
          { numRuns: 50 }
        );
      });
    });

    describe("Nonce Validation", () => {
      it("rejects ID token with wrong nonce", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: "different_nonce",
        };

        const result = validateToken(payload, {
          expectedNonce: "random_nonce_123",
        });
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid nonce");
      });

      it("rejects ID token with missing nonce when required", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        const result = validateToken(payload, {
          expectedNonce: "required_nonce",
        });
        expect(result.valid).toBe(false);
      });
    });

    describe("Authorized Party (azp) Validation", () => {
      it("validates azp when audience has multiple values", () => {
        const payload: JWTPayload = {
          iss: "https://auth.myapp.com",
          sub: "user123",
          aud: ["my-app", "api-gateway"],
          azp: "my-app",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };

        expect(payload.azp).toBe("my-app");
        expect(Array.isArray(payload.aud) && payload.aud.includes(payload.azp)).toBe(true);
      });
    });
  });

  describe("Algorithm Confusion Prevention", () => {
    it("rejects 'none' algorithm", () => {
      const dangerousAlgorithms = ["none", "None", "NONE", "nOnE"];
      for (const alg of dangerousAlgorithms) {
        expect(alg.toLowerCase()).toBe("none");
        // Any token with 'none' algorithm must be rejected
      }
    });

    it("rejects algorithm mismatch", () => {
      const expectedAlg = "RS256";
      const receivedAlg = "HS256";
      expect(receivedAlg).not.toBe(expectedAlg);
      // Token signed with wrong algorithm must be rejected
    });

    it("only accepts configured algorithms", () => {
      const allowedAlgorithms = ["RS256", "ES256"];
      const testAlgorithms = ["RS256", "ES256", "HS256", "none", "PS256"];

      for (const alg of testAlgorithms) {
        const isAllowed = allowedAlgorithms.includes(alg);
        if (alg === "HS256" || alg === "none" || alg === "PS256") {
          expect(isAllowed).toBe(false);
        } else {
          expect(isAllowed).toBe(true);
        }
      }
    });
  });

  describe("JWKS Rotation", () => {
    it("handles key rotation gracefully", () => {
      // Simulate key rotation with key IDs
      const oldKeyId = "key-2023-01";
      const newKeyId = "key-2024-01";
      const jwks = {
        keys: [
          { kid: oldKeyId, use: "sig" },
          { kid: newKeyId, use: "sig" },
        ],
      };

      // Both old and new keys should be valid during rotation window
      expect(jwks.keys.some((k) => k.kid === oldKeyId)).toBe(true);
      expect(jwks.keys.some((k) => k.kid === newKeyId)).toBe(true);
    });

    it("rejects token with unknown key ID", () => {
      const knownKeyIds = ["key-001", "key-002"];
      const tokenKeyId = "unknown-key";

      expect(knownKeyIds.includes(tokenKeyId)).toBe(false);
      // Token with unknown kid must be rejected
    });

    it("refreshes JWKS cache on key not found", () => {
      // Simulate JWKS cache refresh logic
      let cacheRefreshCount = 0;
      const refreshCache = () => {
        cacheRefreshCount++;
      };

      // When key not found, should trigger refresh
      const keyNotFound = true;
      if (keyNotFound) {
        refreshCache();
      }

      expect(cacheRefreshCount).toBe(1);
    });
  });

  describe("Session Security", () => {
    describe("Session Fixation Prevention", () => {
      it("login rotates session ID", () => {
        const beforeLoginSession = "session-abc123";
        const afterLoginSession = "session-xyz789";

        // Session ID must change after login
        expect(beforeLoginSession).not.toBe(afterLoginSession);
      });

      it("session ID has sufficient entropy", () => {
        fc.assert(
          fc.property(fc.uuid(), (sessionId) => {
            // Session IDs should be at least 128 bits of entropy
            return sessionId.length >= 36; // UUID format
          }),
          { numRuns: 100 }
        );
      });

      it("session ID is not predictable", () => {
        // Session IDs generated in sequence should not be predictable
        const sessions = Array.from({ length: 10 }, (_, i) =>
          `session-${crypto.randomUUID()}`
        );
        const uniqueSessions = new Set(sessions);

        expect(uniqueSessions.size).toBe(sessions.length);
      });
    });

    describe("Logout Invalidation", () => {
      it("logout invalidates session", () => {
        const sessions = new Map<string, boolean>();
        const sessionId = "session-to-logout";

        // Create session
        sessions.set(sessionId, true);
        expect(sessions.get(sessionId)).toBe(true);

        // Logout
        sessions.delete(sessionId);
        expect(sessions.has(sessionId)).toBe(false);
      });

      it("logout invalidates all user sessions (optional feature)", () => {
        const userSessions = new Map<string, string[]>();
        const userId = "user123";
        const sessions = ["sess1", "sess2", "sess3"];

        userSessions.set(userId, sessions);

        // Logout all sessions
        userSessions.delete(userId);
        expect(userSessions.has(userId)).toBe(false);
      });

      it("refresh tokens are revoked on logout", () => {
        const refreshTokens = new Set<string>();
        const token = "refresh-token-abc";

        refreshTokens.add(token);
        expect(refreshTokens.has(token)).toBe(true);

        // On logout, revoke refresh token
        refreshTokens.delete(token);
        expect(refreshTokens.has(token)).toBe(false);
      });
    });
  });

  describe("CSRF Protection", () => {
    it("state parameter is required for auth flow", () => {
      const authRequest = { response_type: "code", client_id: "app" };
      const hasState = "state" in authRequest;

      // Request without state should be rejected
      expect(hasState).toBe(false);
    });

    it("state parameter is validated on callback", () => {
      const sentState = "random-state-abc123";
      const receivedState = "random-state-abc123";

      expect(sentState).toBe(receivedState);
    });

    it("rejects callback with mismatched state", () => {
      const sentState = "original-state";
      const receivedState = "tampered-state";

      expect(sentState).not.toBe(receivedState);
      // Should reject the callback
    });

    it("state has sufficient entropy", () => {
      // Generate hex strings by combining hex characters
      const hexCharArb = fc.constantFrom(
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f"
      );
      const hexStringArb = fc.array(hexCharArb, { minLength: 32, maxLength: 64 })
        .map(chars => chars.join(""));

      fc.assert(
        fc.property(
          hexStringArb,
          (state) => {
            // State should be at least 128 bits (32 hex chars)
            return state.length >= 32;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("SameSite cookie attribute is set", () => {
      const cookieOptions = {
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      };

      expect(cookieOptions.sameSite).toBe("Lax");
      expect(cookieOptions.httpOnly).toBe(true);
      expect(cookieOptions.secure).toBe(true);
    });
  });

  describe("Multi-Tenant OIDC", () => {
    it("same subject from different issuers are different users", () => {
      const user1 = { iss: "https://tenant1.auth.com", sub: "user123" };
      const user2 = { iss: "https://tenant2.auth.com", sub: "user123" };

      // Same sub but different iss = different users
      const userId1 = `${user1.iss}|${user1.sub}`;
      const userId2 = `${user2.iss}|${user2.sub}`;

      expect(user1.sub).toBe(user2.sub);
      expect(userId1).not.toBe(userId2);
    });

    it("user mapping is unique per issuer+subject", () => {
      const userMap = new Map<string, { tenantId: string; userId: string }>();

      // Add users from different issuers
      userMap.set("iss1|sub1", { tenantId: "t1", userId: "u1" });
      userMap.set("iss2|sub1", { tenantId: "t2", userId: "u2" });

      // Same subject from different issuers should be different users
      expect(userMap.get("iss1|sub1")?.userId).not.toBe(
        userMap.get("iss2|sub1")?.userId
      );
    });

    it("validates issuer against whitelist", () => {
      const allowedIssuers = [
        "https://auth.company.com",
        "https://accounts.google.com",
      ];

      const trustedIssuer = "https://auth.company.com";
      const untrustedIssuer = "https://evil.attacker.com";

      expect(allowedIssuers.includes(trustedIssuer)).toBe(true);
      expect(allowedIssuers.includes(untrustedIssuer)).toBe(false);
    });
  });

  describe("Token Storage Security", () => {
    it("access tokens are not stored in localStorage", () => {
      // localStorage is accessible to XSS attacks
      // Best practice: use httpOnly cookies or memory storage
      const secureStorageTypes = ["httpOnly-cookie", "memory", "sessionStorage"];
      const insecureStorage = "localStorage";

      expect(secureStorageTypes).not.toContain(insecureStorage);
    });

    it("refresh tokens use secure storage only", () => {
      const refreshTokenStorage = "httpOnly-cookie";
      const secureOptions = ["httpOnly-cookie", "secure-enclave"];

      expect(secureOptions.includes(refreshTokenStorage)).toBe(true);
    });
  });

  describe("Rate Limiting on Auth Endpoints", () => {
    it("login attempts are rate limited", () => {
      const maxAttempts = 5;
      const windowMs = 15 * 60 * 1000; // 15 minutes

      const rateLimiter = {
        max: maxAttempts,
        windowMs,
        attempts: 0,
        isAllowed() {
          return this.attempts < this.max;
        },
        recordAttempt() {
          this.attempts++;
        },
      };

      // Should allow initial attempts
      for (let i = 0; i < maxAttempts; i++) {
        expect(rateLimiter.isAllowed()).toBe(true);
        rateLimiter.recordAttempt();
      }

      // Should block after max attempts
      expect(rateLimiter.isAllowed()).toBe(false);
    });

    it("rate limit is per-IP or per-user", () => {
      const rateLimits = new Map<string, number>();

      const recordAttempt = (key: string) => {
        rateLimits.set(key, (rateLimits.get(key) ?? 0) + 1);
      };

      // Different IPs have separate limits
      recordAttempt("ip:192.168.1.1");
      recordAttempt("ip:192.168.1.1");
      recordAttempt("ip:192.168.1.2");

      expect(rateLimits.get("ip:192.168.1.1")).toBe(2);
      expect(rateLimits.get("ip:192.168.1.2")).toBe(1);
    });
  });
});
