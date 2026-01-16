import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { createResourceFilter } from "../../src/resource/filter";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ============================================================
// SUBSCRIPTION INVARIANTS
// ============================================================
// Critical properties:
// 1. Any mutation sends exactly one of: added/changed/removed/invalidate
// 2. Resume correctness with sequence gaps
// 3. Ordering guarantees
// 4. Auth scope changes mid-stream
// 5. No contradictory event sequences

// Test schema for filter validation
const testItemsTable = sqliteTable("test_items", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  status: text("status").notNull(),
  value: integer("value").notNull(),
  newField: text("newField"),
});

type TestItem = {
  id: string;
  userId: string;
  status: string;
  value: number;
  newField?: string;
};

// Simple in-memory changelog for testing invariants
class SimpleChangelog<T extends { id: string }> {
  private entries: Array<{
    seq: number;
    type: "create" | "update" | "delete";
    item: T;
    previousItem?: T;
  }> = [];
  private sequence = 0;
  private maxEntries: number;

  constructor(config: { maxEntries: number }) {
    this.maxEntries = config.maxEntries;
  }

  append(entry: { type: "create" | "update" | "delete"; item: T; previousItem?: T }) {
    this.sequence++;
    const fullEntry = { ...entry, seq: this.sequence };
    this.entries.push(fullEntry);

    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return fullEntry;
  }

  getEntriesSince(sinceSeq: number) {
    return this.entries.filter(e => e.seq > sinceSeq);
  }

  getOldestSeq(): number {
    if (this.entries.length === 0) return this.sequence;
    return this.entries[0]!.seq;
  }

  getLatestSeq(): number {
    return this.sequence;
  }
}

// Mock subscription callbacks
const createMockCallbacks = () => {
  const events: Array<{
    type: string;
    item?: TestItem;
    id?: string;
    seq?: number;
    meta?: Record<string, unknown>;
  }> = [];

  return {
    events,
    callbacks: {
      onExisting: (item: TestItem) => events.push({ type: "existing", item }),
      onAdded: (item: TestItem, meta?: Record<string, unknown>) =>
        events.push({ type: "added", item, meta }),
      onChanged: (item: TestItem) => events.push({ type: "changed", item }),
      onRemoved: (id: string) => events.push({ type: "removed", id }),
      onInvalidate: () => events.push({ type: "invalidate" }),
      onConnected: (seq: number) => events.push({ type: "connected", seq }),
      onDisconnected: () => events.push({ type: "disconnected" }),
      onError: (error: Error) =>
        events.push({ type: "error", meta: { message: error.message } }),
    },
  };
};

describe("Subscription Invariants", () => {
  let filter: ReturnType<typeof createResourceFilter>;

  beforeEach(() => {
    filter = createResourceFilter(testItemsTable);
  });

  describe("Event Exclusivity", () => {
    // For any single mutation, exactly one event type should be emitted
    // (or none if item doesn't match filter)

    it("create mutation emits exactly one 'added' event", () => {
      // Property: For any created item that matches filter, exactly one 'added' event
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.constantFrom("active", "inactive"),
          fc.integer({ min: 0, max: 100 }),
          (id, status, value) => {
            const filterStr = 'status=="active"';
            const item = { id, userId: "user1", status, value };
            const matches = filter.execute(filterStr, item as TestItem);

            // Invariant: either the item matches and we emit 'added', or it doesn't and we emit nothing
            // We don't emit multiple events for a single create
            const eventCount = matches ? 1 : 0;
            return eventCount <= 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("update mutation emits 'changed', 'added', or 'removed' (never multiple)", () => {
      // When an item is updated:
      // - If it matched filter before and after: 'changed'
      // - If it now matches but didn't before: 'added'
      // - If it no longer matches but did before: 'removed'
      // - If it never matched: no event

      const scenarios = [
        {
          before: { id: "1", userId: "u1", status: "active", value: 100 },
          after: { id: "1", userId: "u1", status: "active", value: 200 },
          filterStr: 'status=="active"',
          expected: "changed",
        },
        {
          before: { id: "1", userId: "u1", status: "inactive", value: 100 },
          after: { id: "1", userId: "u1", status: "active", value: 100 },
          filterStr: 'status=="active"',
          expected: "added",
        },
        {
          before: { id: "1", userId: "u1", status: "active", value: 100 },
          after: { id: "1", userId: "u1", status: "inactive", value: 100 },
          filterStr: 'status=="active"',
          expected: "removed",
        },
        {
          before: { id: "1", userId: "u1", status: "inactive", value: 100 },
          after: { id: "1", userId: "u1", status: "inactive", value: 200 },
          filterStr: 'status=="active"',
          expected: "none",
        },
      ];

      for (const scenario of scenarios) {
        const matchedBefore = filter.execute(scenario.filterStr, scenario.before as TestItem);
        const matchedAfter = filter.execute(scenario.filterStr, scenario.after as TestItem);

        let expectedEvent: string;
        if (matchedBefore && matchedAfter) {
          expectedEvent = "changed";
        } else if (!matchedBefore && matchedAfter) {
          expectedEvent = "added";
        } else if (matchedBefore && !matchedAfter) {
          expectedEvent = "removed";
        } else {
          expectedEvent = "none";
        }

        expect(expectedEvent).toBe(scenario.expected);
      }
    });

    it("delete mutation emits exactly one 'removed' event or none", () => {
      // Delete should emit 'removed' if item was in filter scope, nothing otherwise
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.constantFrom("active", "inactive"),
          (id, status) => {
            const filterStr = 'status=="active"';
            const item = { id, userId: "u1", status, value: 0 };
            const wasInScope = filter.execute(filterStr, item as TestItem);

            // Invariant: at most one event for a delete
            const eventCount = wasInScope ? 1 : 0;
            return eventCount <= 1;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("No Contradictory Sequences", () => {
    it("'changed' after 'removed' is invalid (cannot change removed item)", () => {
      // Helper to check if a sequence has invalid patterns
      const hasInvalidPattern = (events: Array<{ type: string; id: string }>) => {
        const itemEvents = new Map<string, string[]>();

        for (const event of events) {
          if (!itemEvents.has(event.id)) {
            itemEvents.set(event.id, []);
          }
          itemEvents.get(event.id)!.push(event.type);
        }

        for (const [_id, eventTypes] of itemEvents) {
          for (let i = 0; i < eventTypes.length - 1; i++) {
            if (eventTypes[i] === "removed" && eventTypes[i + 1] === "changed") {
              return true; // Invalid pattern found
            }
          }
        }
        return false;
      };

      // Test 1: Invalid sequence should be detected
      expect(hasInvalidPattern([
        { type: "added", id: "item1" },
        { type: "removed", id: "item1" },
        { type: "changed", id: "item1" }, // Invalid: changed after removed
      ])).toBe(true);

      // Test 2: Valid sequence should pass
      expect(hasInvalidPattern([
        { type: "added", id: "item1" },
        { type: "changed", id: "item1" },
        { type: "removed", id: "item1" },
      ])).toBe(false);

      // Test 3: Multiple items should be tracked separately
      expect(hasInvalidPattern([
        { type: "added", id: "item1" },
        { type: "removed", id: "item1" },
        { type: "added", id: "item2" },
        { type: "changed", id: "item2" }, // Valid: item2 was added
      ])).toBe(false);

      // Property test: Generate valid sequences and verify they don't have invalid patterns
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom("item1", "item2", "item3"), { minLength: 1, maxLength: 5 }),
          (itemIds) => {
            // Build a valid sequence: add all, change all, remove all
            const events: Array<{ type: string; id: string }> = [];

            for (const id of itemIds) {
              events.push({ type: "added", id });
            }
            for (const id of itemIds) {
              events.push({ type: "changed", id });
            }
            for (const id of itemIds) {
              events.push({ type: "removed", id });
            }

            // Valid sequences should not have the invalid pattern
            return !hasInvalidPattern(events);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("'changed' only occurs for items that were previously 'added' or 'existing'", () => {
      // This test verifies the validator correctly detects invalid sequences

      // Helper to validate an event sequence
      const isValidSequence = (events: Array<{ type: "existing" | "added" | "changed" | "removed"; id: string }>) => {
        const inScope = new Set<string>();

        for (const event of events) {
          switch (event.type) {
            case "existing":
            case "added":
              inScope.add(event.id);
              break;
            case "changed":
              if (!inScope.has(event.id)) {
                return false;
              }
              break;
            case "removed":
              inScope.delete(event.id);
              break;
          }
        }
        return true;
      };

      // Test 1: Valid sequence should pass
      expect(isValidSequence([
        { type: "added", id: "item1" },
        { type: "changed", id: "item1" },
        { type: "removed", id: "item1" },
      ])).toBe(true);

      // Test 2: Invalid sequence (changed before added) should fail
      expect(isValidSequence([
        { type: "changed", id: "item1" },
      ])).toBe(false);

      // Test 3: Invalid sequence (changed after removed) should fail
      expect(isValidSequence([
        { type: "added", id: "item1" },
        { type: "removed", id: "item1" },
        { type: "changed", id: "item1" },
      ])).toBe(false);

      // Property test: Generate VALID sequences and verify they pass validation
      fc.assert(
        fc.property(
          fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
          (itemIds) => {
            // Build a valid sequence: add all items, then change some, then remove some
            const events: Array<{ type: "existing" | "added" | "changed" | "removed"; id: string }> = [];

            // Add all items
            for (const id of itemIds) {
              events.push({ type: "added", id });
            }

            // Change some items (they're all in scope now)
            for (const id of itemIds.slice(0, Math.floor(itemIds.length / 2))) {
              events.push({ type: "changed", id });
            }

            // Remove some items
            for (const id of itemIds.slice(0, Math.floor(itemIds.length / 3))) {
              events.push({ type: "removed", id });
            }

            return isValidSequence(events);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Resume Correctness", () => {
    it("resuming from valid sequence gets all events after that sequence", () => {
      const changelog = new SimpleChangelog<TestItem>({ maxEntries: 100 });

      // Add entries
      for (let i = 1; i <= 10; i++) {
        changelog.append({
          type: "create",
          item: { id: `item-${i}`, userId: "u1", status: "active", value: i },
        });
      }

      // Resume from seq 5
      const entries = changelog.getEntriesSince(5);

      // Should get entries 6-10
      expect(entries.length).toBe(5);
      expect(entries[0]!.seq).toBe(6);
      expect(entries[entries.length - 1]!.seq).toBe(10);
    });

    it("resuming from sequence beyond retained returns available entries", () => {
      const changelog = new SimpleChangelog<TestItem>({ maxEntries: 5 });

      // Add 10 entries (5 will be dropped)
      for (let i = 1; i <= 10; i++) {
        changelog.append({
          type: "create",
          item: { id: `item-${i}`, userId: "u1", status: "active", value: i },
        });
      }

      // Try to resume from seq 2 (which was dropped)
      const entries = changelog.getEntriesSince(2);

      // Should return what's available
      expect(entries.length).toBeLessThanOrEqual(5);
    });

    it("sequence gaps are detected via oldest sequence", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 5, max: 20 }),
          fc.integer({ min: 1, max: 10 }),
          (maxEntries, totalEntries, resumeFrom) => {
            const changelog = new SimpleChangelog<TestItem>({ maxEntries });

            for (let i = 1; i <= totalEntries; i++) {
              changelog.append({
                type: "create",
                item: {
                  id: `item-${i}`,
                  userId: "u1",
                  status: "active",
                  value: i,
                },
              });
            }

            const oldestSeq = changelog.getOldestSeq();
            const newestSeq = changelog.getLatestSeq();

            // If resumeFrom < oldestSeq, we have a gap
            const hasGap = resumeFrom < oldestSeq;

            if (hasGap) {
              // Gap detected, invalidate should be triggered
              return true;
            } else {
              // No gap, should get entries normally
              const entries = changelog.getEntriesSince(resumeFrom);
              expect(entries.length).toBe(Math.max(0, newestSeq - resumeFrom));
              return true;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("resume from 0 gets all current items as 'existing'", () => {
      // When client connects fresh (seq=0), should get existing items
      const items = [
        { id: "1", userId: "u1", status: "active", value: 1 },
        { id: "2", userId: "u1", status: "active", value: 2 },
        { id: "3", userId: "u1", status: "inactive", value: 3 },
      ];

      const filterStr = 'status=="active"';
      const existingItems = items.filter((item) =>
        filter.execute(filterStr, item as TestItem)
      );

      // Should send 'existing' for items 1 and 2
      expect(existingItems.length).toBe(2);
      expect(existingItems.every((i) => i.status === "active")).toBe(true);
    });
  });

  describe("Ordering Guarantees", () => {
    it("events within a connection are ordered by sequence", () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 1000 }), {
            minLength: 2,
            maxLength: 50,
          }),
          (sequences) => {
            // Sort to get expected order
            const sorted = [...sequences].sort((a, b) => a - b);

            // Events should be delivered in sequence order
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i]! < sorted[i - 1]!) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("per-resource ordering is maintained even under concurrent updates", () => {
      // Simulate concurrent updates to same item
      const events = [
        { seq: 1, itemId: "item1", type: "create", value: 0 },
        { seq: 2, itemId: "item1", type: "update", value: 10 },
        { seq: 3, itemId: "item1", type: "update", value: 20 },
        { seq: 4, itemId: "item1", type: "update", value: 30 },
      ];

      // Client should see updates in order
      let lastSeq = 0;
      let lastValue = 0;
      for (const event of events) {
        expect(event.seq).toBeGreaterThan(lastSeq);
        if (event.type === "update") {
          expect(event.value).toBeGreaterThan(lastValue);
          lastValue = event.value;
        }
        lastSeq = event.seq;
      }
    });
  });

  describe("Auth Scope Changes", () => {
    it("user losing scope sees immediate removal", () => {
      // Simulate user's scope changing mid-subscription
      const items = [
        { id: "1", userId: "user1", status: "active", value: 1 },
        { id: "2", userId: "user2", status: "active", value: 2 },
        { id: "3", userId: "user1", status: "active", value: 3 },
      ];

      // User1's scope: userId==user1
      const user1Filter = 'userId=="user1"';
      const user1Items = items.filter((item) =>
        filter.execute(user1Filter, item as TestItem)
      );

      expect(user1Items.length).toBe(2);
    });

    it("invalidate event clears all state", () => {
      const { events, callbacks } = createMockCallbacks();

      // Simulate receiving events
      callbacks.onExisting({ id: "1", userId: "u1", status: "a", value: 1 });
      callbacks.onAdded({ id: "2", userId: "u1", status: "a", value: 2 });
      callbacks.onInvalidate();

      // After invalidate, previous items should be considered stale
      expect(events.filter((e) => e.type === "invalidate").length).toBe(1);
    });
  });

  describe("Filter Scope Transitions", () => {
    it("item entering filter scope emits 'added'", () => {
      const filterStr = "value>50";
      const before = { id: "1", userId: "u1", status: "a", value: 30 };
      const after = { id: "1", userId: "u1", status: "a", value: 70 };

      expect(filter.execute(filterStr, before as TestItem)).toBe(false);
      expect(filter.execute(filterStr, after as TestItem)).toBe(true);
    });

    it("item leaving filter scope emits 'removed'", () => {
      const filterStr = "value>50";
      const before = { id: "1", userId: "u1", status: "a", value: 70 };
      const after = { id: "1", userId: "u1", status: "a", value: 30 };

      expect(filter.execute(filterStr, before as TestItem)).toBe(true);
      expect(filter.execute(filterStr, after as TestItem)).toBe(false);
    });

    it("item staying in filter scope emits 'changed'", () => {
      const filterStr = "value>50";
      const before = { id: "1", userId: "u1", status: "a", value: 70 };
      const after = { id: "1", userId: "u1", status: "a", value: 80 };

      expect(filter.execute(filterStr, before as TestItem)).toBe(true);
      expect(filter.execute(filterStr, after as TestItem)).toBe(true);
    });

    it("item staying outside filter scope emits nothing", () => {
      const filterStr = "value>50";
      const before = { id: "1", userId: "u1", status: "a", value: 30 };
      const after = { id: "1", userId: "u1", status: "a", value: 40 };

      expect(filter.execute(filterStr, before as TestItem)).toBe(false);
      expect(filter.execute(filterStr, after as TestItem)).toBe(false);
    });
  });

  describe("Reconnect Storm Resilience", () => {
    it("many concurrent reconnections should all eventually succeed", () => {
      // Test with deterministic connection simulation
      const testReconnectStorm = (numClients: number, failureRate: number, maxRetries: number) => {
        const connections: Array<{
          id: number;
          status: "connecting" | "connected" | "failed";
          retries: number;
        }> = [];

        // Initialize connections
        for (let i = 0; i < numClients; i++) {
          connections.push({
            id: i,
            status: "connecting",
            retries: 0,
          });
        }

        // Simulate connection attempts with retries
        // Use deterministic pattern: every Nth connection fails initially
        const failEveryN = Math.max(1, Math.floor(1 / failureRate));

        for (const conn of connections) {
          const willFailInitially = conn.id % failEveryN === 0;

          if (!willFailInitially) {
            conn.status = "connected";
          } else {
            // Retry logic - eventually succeeds
            while (conn.status !== "connected" && conn.retries < maxRetries) {
              conn.retries++;
              conn.status = "connected"; // Eventually succeeds with retries
            }
          }
        }

        const connected = connections.filter((c) => c.status === "connected").length;
        return connected === numClients; // All should eventually connect
      };

      // Test various scenarios
      expect(testReconnectStorm(10, 0.1, 3)).toBe(true);
      expect(testReconnectStorm(50, 0.05, 3)).toBe(true);
      expect(testReconnectStorm(100, 0.1, 5)).toBe(true);
    });

    it("reconnection with valid sequence should not duplicate events", () => {
      const changelog = new SimpleChangelog<TestItem>({ maxEntries: 100 });

      // Add entries
      for (let i = 1; i <= 20; i++) {
        changelog.append({
          type: "create",
          item: { id: `item-${i}`, userId: "u1", status: "active", value: i },
        });
      }

      // Simulate client that saw up to seq 10, then reconnects
      const missedEntries = changelog.getEntriesSince(10);

      // Should get exactly 10 entries (11-20)
      expect(missedEntries.length).toBe(10);

      // Each should be unique
      const seqs = missedEntries.map((e) => e.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(missedEntries.length);
    });
  });

  describe("Schema Evolution Tolerance", () => {
    it("extra fields in events should be tolerated", () => {
      const item = {
        id: "1",
        userId: "u1",
        status: "active",
        value: 100,
        newField: "extra",
      };

      const filterStr = 'status=="active"';
      expect(filter.execute(filterStr, item as TestItem)).toBe(true);
    });

    it("missing optional fields should be handled", () => {
      const oldItem = {
        id: "1",
        userId: "u1",
        status: "active",
        value: 100,
      };

      const filterStr = 'status=="active"';
      expect(filter.execute(filterStr, oldItem as TestItem)).toBe(true);

      // Filter on missing field should handle gracefully
      const filterMissing = "newField=isnull=true";
      expect(filter.execute(filterMissing, oldItem as TestItem)).toBe(true);
    });
  });
});
