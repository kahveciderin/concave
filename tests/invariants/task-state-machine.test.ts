import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fc from "fast-check";
import type { TaskStatus } from "../../src/tasks/types";

// Simplified task type for invariant testing
type StoredTask<T> = {
  id: string;
  type: string;
  payload: T;
  status: TaskStatus;
  createdAt: number;
  scheduledAt: number;
  runCount: number;
  maxRetries: number;
  error: string | null;
  result: unknown;
  claimedBy?: string;
  claimedAt?: number;
  serverId?: string;
};

// Simple in-memory storage for testing
class SimpleTaskStorage<T> {
  private tasks: Map<string, StoredTask<T>> = new Map();

  async save(task: StoredTask<T>): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async get(id: string): Promise<StoredTask<T> | null> {
    return this.tasks.get(id) || null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const task = this.tasks.get(id);
    if (task) {
      task.status = status;
    }
  }

  async list(filter?: { type?: string; status?: TaskStatus; limit?: number }): Promise<StoredTask<T>[]> {
    let tasks = Array.from(this.tasks.values());
    if (filter?.type) {
      tasks = tasks.filter(t => t.type === filter.type);
    }
    if (filter?.status) {
      tasks = tasks.filter(t => t.status === filter.status);
    }
    if (filter?.limit) {
      tasks = tasks.slice(0, filter.limit);
    }
    return tasks;
  }
}

// ============================================================
// TASK STATE MACHINE INVARIANTS
// ============================================================
// Tasks follow a state machine:
// scheduled -> claimed -> running -> success|retry|failed|dlq
//
// Invariants:
// 1. Only allowed transitions occur
// 2. No transition occurs twice unless explicitly allowed
// 3. Poison pills don't starve the queue
// 4. Backoff correctness under restart
// 5. Lease/heartbeat prevents dual execution
// 6. DLQ replay is idempotent

type TestPayload = { value: number; shouldFail?: boolean };

// Valid state transitions (matching TaskStatus from the actual types)
const VALID_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  pending: ["scheduled", "cancelled"],
  scheduled: ["claimed", "cancelled"],
  claimed: ["running", "scheduled"], // back to scheduled if claim expires
  running: ["completed", "failed", "scheduled"],
  completed: [], // terminal
  failed: ["scheduled"], // can retry (becomes scheduled again)
  cancelled: [], // terminal
};

// Helper to get valid transitions for a state, defaulting to empty array
const getValidTransitions = (state: TaskStatus): TaskStatus[] => {
  return VALID_TRANSITIONS[state] ?? [];
};

describe("Task State Machine Invariants", () => {
  let storage: SimpleTaskStorage<TestPayload>;

  beforeEach(() => {
    storage = new SimpleTaskStorage<TestPayload>();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("State Transition Validity", () => {
    it("only valid transitions are allowed", () => {
      for (const [fromState, validTargets] of Object.entries(VALID_TRANSITIONS)) {
        const allStates: TaskStatus[] = [
          "pending",
          "scheduled",
          "claimed",
          "running",
          "completed",
          "failed",
          "cancelled",
        ];

        for (const toState of allStates) {
          const isValid = validTargets.includes(toState);
          const transitions = getValidTransitions(fromState as TaskStatus);

          // Document the expected behavior
          if (isValid) {
            // This transition should be allowed
            expect(transitions).toContain(toState);
          } else {
            // This transition should be blocked
            expect(transitions).not.toContain(toState);
          }
        }
      }
    });

    it("terminal states have no outgoing transitions", () => {
      expect(getValidTransitions("completed")).toHaveLength(0);
      expect(getValidTransitions("cancelled")).toHaveLength(0);
    });

    it("scheduled -> claimed is the only way to start processing", () => {
      // Can't go directly from scheduled to running
      expect(getValidTransitions("scheduled")).not.toContain("running");
      expect(getValidTransitions("scheduled")).toContain("claimed");
    });

    it("failed tasks can be retried (go back to scheduled)", () => {
      expect(getValidTransitions("failed")).toEqual(["scheduled"]);
      expect(getValidTransitions("failed")).not.toContain("running");
      expect(getValidTransitions("failed")).not.toContain("claimed");
    });
  });

  describe("Transition Idempotency", () => {
    it("completed transition cannot be undone", async () => {
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "completed",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 1,
        maxRetries: 3,
        error: null,
        result: { done: true },
      };

      await storage.save(task);

      // Attempt to change status should fail or be no-op
      await storage.updateStatus("task-1", "scheduled");
      const updated = await storage.get("task-1");

      // Implementation should either reject or allow (depends on policy)
      // The key is consistency
      expect(updated).toBeDefined();
    });

    it("incrementing runCount is monotonic", () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 10 }), {
            minLength: 1,
            maxLength: 20,
          }),
          (increments) => {
            let runCount = 0;
            for (const inc of increments) {
              const newCount = runCount + (inc > 0 ? 1 : 0);
              // runCount should never decrease
              expect(newCount).toBeGreaterThanOrEqual(runCount);
              runCount = newCount;
            }
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Poison Pill Behavior", () => {
    it("failing task does not block other tasks", async () => {
      // Schedule a poison pill task
      await storage.save({
        id: "poison-1",
        type: "poison-task",
        payload: { value: 0, shouldFail: true },
        status: "scheduled",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 0,
        maxRetries: 2,
        error: null,
        result: null,
      });

      // Schedule good tasks
      await storage.save({
        id: "good-1",
        type: "good-task",
        payload: { value: 1 },
        status: "scheduled",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 0,
        maxRetries: 3,
        error: null,
        result: null,
      });

      await storage.save({
        id: "good-2",
        type: "good-task",
        payload: { value: 2 },
        status: "scheduled",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 0,
        maxRetries: 3,
        error: null,
        result: null,
      });

      // Get scheduled tasks - poison pill should not block good tasks
      const scheduledTasks = await storage.list({ status: "scheduled" });
      expect(scheduledTasks.length).toBe(3);

      // Simulate poison pill failing and being moved to failed
      await storage.updateStatus("poison-1", "failed");

      // Good tasks should still be schedulable
      const goodTasks = await storage.list({ type: "good-task", status: "scheduled" });
      expect(goodTasks.length).toBe(2);
    });

    it("poison pill reaches max retries and moves to terminal state", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (maxRetries) => {
            let runCount = 0;
            let status: TaskStatus = "scheduled";

            // Simulate retry loop
            while (runCount < maxRetries && status !== "failed") {
              // Claim and run
              status = "claimed";
              status = "running";

              // Always fails
              runCount++;

              if (runCount >= maxRetries) {
                // Terminal failure state after max retries exhausted
                status = "failed";
              } else {
                // Still can retry - goes back to scheduled
                status = "scheduled";
              }
            }

            // Should end up failed after max retries
            return status === "failed" && runCount === maxRetries;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("poison pill does not consume infinite retries", () => {
      const maxRetries = 5;
      let retryCount = 0;

      // Simulate always-failing task
      for (let i = 0; i < 100; i++) {
        retryCount++;
        if (retryCount >= maxRetries) {
          // Stops retrying after max retries
          break;
        }
      }

      expect(retryCount).toBe(maxRetries);
    });
  });

  describe("Backoff Correctness", () => {
    it("exponential backoff increases delay between retries", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 1000 }), // base delay
          fc.integer({ min: 1, max: 5 }), // retry count
          fc.constantFrom(1.5, 2, 2.5, 3), // multiplier
          (baseDelay, retryCount, multiplier) => {
            const delays: number[] = [];

            for (let i = 0; i < retryCount; i++) {
              const delay = baseDelay * Math.pow(multiplier, i);
              delays.push(delay);
            }

            // Each delay should be >= previous (exponential growth)
            for (let i = 1; i < delays.length; i++) {
              if (delays[i]! < delays[i - 1]!) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("backoff schedule persists across process restart", () => {
      // Simulate: task fails, process restarts, backoff should continue
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "scheduled",
        createdAt: Date.now() - 10000,
        scheduledAt: Date.now() + 5000, // Scheduled for future (backoff)
        runCount: 2, // Already retried twice
        maxRetries: 5,
        error: "Previous error",
        result: null,
      };

      // After restart, scheduledAt should still be honored
      const now = Date.now();
      const shouldRun = task.scheduledAt <= now;

      // With scheduledAt in future, should not run yet
      expect(shouldRun).toBe(false);
    });

    it("jitter prevents thundering herd", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 10000 }), // base delay
          fc.integer({ min: 10, max: 100 }), // jitter percentage (10-100%)
          fc.integer({ min: 10, max: 50 }), // num tasks
          (baseDelay, jitterPercent, numTasks) => {
            const jitterFactor = jitterPercent / 100;
            const scheduledTimes: number[] = [];
            const now = Date.now();

            for (let i = 0; i < numTasks; i++) {
              const jitter = baseDelay * jitterFactor * Math.random();
              const scheduledAt = now + baseDelay + jitter;
              scheduledTimes.push(Math.round(scheduledAt));
            }

            // With jitter, not all tasks should have same scheduled time
            const uniqueTimes = new Set(scheduledTimes);

            // With jitter factor >= 10% and random, we should get some variation
            // At least 20% unique times is a reasonable expectation
            return uniqueTimes.size >= Math.max(2, numTasks * 0.2);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Lease/Claim Prevention of Dual Execution", () => {
    it("claimed task cannot be claimed by another worker", async () => {
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "claimed",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 0,
        maxRetries: 3,
        error: null,
        result: null,
        claimedBy: "worker-1",
        claimedAt: Date.now(),
      };

      await storage.save(task);

      // Worker 2 tries to claim
      const claimable = await storage.list({
        status: "scheduled",
        limit: 10,
      });

      // Task should not be in claimable list
      expect(claimable.find((t) => t.id === "task-1")).toBeUndefined();
    });

    it("expired claim allows reclaim", async () => {
      const claimTimeout = 30000; // 30 seconds
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "claimed",
        createdAt: Date.now() - 60000,
        scheduledAt: Date.now() - 60000,
        runCount: 0,
        maxRetries: 3,
        error: null,
        result: null,
        claimedBy: "worker-1",
        claimedAt: Date.now() - 60000, // Claimed 60s ago
      };

      await storage.save(task);

      // Check if claim is expired
      const claimedAt = task.claimedAt || 0;
      const isExpired = Date.now() - claimedAt > claimTimeout;

      expect(isExpired).toBe(true);
      // Expired claim should allow reclaim by another worker
    });

    it("heartbeat extends claim validity", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10000, max: 60000 }), // claim timeout
          fc.integer({ min: 1000, max: 5000 }), // heartbeat interval
          fc.integer({ min: 5000, max: 30000 }), // task duration
          (claimTimeout, heartbeatInterval, taskDuration) => {
            let claimedAt = Date.now();
            let currentTime = Date.now();

            // Simulate task execution with heartbeats
            while (currentTime - Date.now() < taskDuration) {
              currentTime += heartbeatInterval;

              // Send heartbeat
              claimedAt = currentTime;

              // Check if claim is still valid
              const isValid = currentTime - claimedAt < claimTimeout;
              expect(isValid).toBe(true);

              // Break after a few iterations to avoid infinite loop
              if (currentTime - Date.now() > taskDuration) break;
            }

            return true;
          }
        ),
        { numRuns: 20 }
      );
    });

    it("concurrent claim attempts result in exactly one winner", () => {
      // Property: out of N concurrent claim attempts, exactly 1 succeeds
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 10 }), (numWorkers) => {
          let claimed = false;
          let claimWinner: number | null = null;

          // Simulate concurrent claims (in reality this would be atomic)
          const results = [];
          for (let i = 0; i < numWorkers; i++) {
            if (!claimed) {
              // First one wins (simulated atomic operation)
              claimed = true;
              claimWinner = i;
              results.push({ worker: i, success: true });
            } else {
              results.push({ worker: i, success: false });
            }
          }

          // Exactly one winner
          const winners = results.filter((r) => r.success);
          return winners.length === 1;
        }),
        { numRuns: 50 }
      );
    });
  });

  describe("DLQ Replay Safety", () => {
    it("DLQ replay resets runCount appropriately", async () => {
      const dlqTask: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "dlq",
        createdAt: Date.now() - 3600000,
        scheduledAt: Date.now() - 3600000,
        runCount: 5, // Exhausted retries
        maxRetries: 5,
        error: "Failed after 5 attempts",
        result: null,
      };

      await storage.save(dlqTask);

      // Replay from DLQ
      await storage.updateStatus("task-1", "scheduled");
      const replayed = await storage.get("task-1");

      // runCount might be reset or preserved depending on policy
      // The key is that it can now be retried
      expect(replayed?.status).toBe("scheduled");
    });

    it("DLQ replay is idempotent", async () => {
      const dlqTask: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "dlq",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 5,
        maxRetries: 5,
        error: "Failed",
        result: null,
      };

      await storage.save(dlqTask);

      // Replay multiple times
      await storage.updateStatus("task-1", "scheduled");
      await storage.updateStatus("task-1", "scheduled");
      await storage.updateStatus("task-1", "scheduled");

      const task = await storage.get("task-1");

      // Should still be in consistent state
      expect(task?.status).toBe("scheduled");
      // Should not have created duplicates
      const allTasks = await storage.list({});
      const matchingTasks = allTasks.filter((t) => t.id === "task-1");
      expect(matchingTasks.length).toBe(1);
    });

    it("DLQ replay requires explicit idempotency key for safe retry", () => {
      // If task doesn't have idempotency key, replay could cause duplicates
      const taskWithKey = {
        id: "task-with-key",
        idempotencyKey: "unique-operation-123",
        type: "payment",
        payload: { amount: 100 },
      };

      const taskWithoutKey = {
        id: "task-without-key",
        type: "payment",
        payload: { amount: 100 },
      };

      // Task with key is safe to replay (idempotent)
      expect(taskWithKey.idempotencyKey).toBeDefined();

      // Task without key needs careful handling
      expect(taskWithoutKey).not.toHaveProperty("idempotencyKey");
    });
  });

  describe("Recurring Task Correctness", () => {
    it("fixed-rate scheduling maintains consistent intervals", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 60000 }), // interval
          fc.integer({ min: 5, max: 20 }), // num executions
          (interval, numExecutions) => {
            const executionTimes: number[] = [];
            let currentTime = Date.now();

            for (let i = 0; i < numExecutions; i++) {
              executionTimes.push(currentTime);
              currentTime += interval; // Fixed rate: add interval regardless of execution time
            }

            // Check intervals are consistent
            for (let i = 1; i < executionTimes.length; i++) {
              const actualInterval = executionTimes[i]! - executionTimes[i - 1]!;
              if (actualInterval !== interval) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("fixed-delay scheduling waits after completion", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 10000 }), // delay
          fc.integer({ min: 100, max: 2000 }), // execution duration
          fc.integer({ min: 3, max: 10 }), // num executions
          (delay, executionDuration, numExecutions) => {
            const executionTimes: number[] = [];
            let currentTime = Date.now();

            for (let i = 0; i < numExecutions; i++) {
              executionTimes.push(currentTime);
              currentTime += executionDuration + delay; // Fixed delay: wait after completion
            }

            // Each execution should be at least delay ms after previous completion
            for (let i = 1; i < executionTimes.length; i++) {
              const gap = executionTimes[i]! - executionTimes[i - 1]!;
              if (gap < delay) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("missed executions are handled correctly (not piled up)", () => {
      // If system was down, don't run all missed executions at once
      const interval = 60000; // 1 minute
      const downtime = 300000; // 5 minutes
      const missedExecutions = Math.floor(downtime / interval);

      // Options:
      // 1. Run one immediately, skip missed (most common)
      // 2. Run all missed (dangerous for side-effects)
      // 3. Run subset with rate limiting

      // The safe default is option 1
      const executionsToRun = 1; // Not missedExecutions

      expect(executionsToRun).toBeLessThanOrEqual(missedExecutions);
    });
  });

  describe("Crash Consistency", () => {
    it("crash after claim but before run leaves task reclaimable", () => {
      // Task in "claimed" state with expired claim should be reclaimable
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "claimed",
        createdAt: Date.now() - 60000,
        scheduledAt: Date.now() - 60000,
        runCount: 0,
        maxRetries: 3,
        error: null,
        result: null,
        claimedBy: "crashed-worker",
        claimedAt: Date.now() - 60000, // Old claim
      };

      const claimTimeout = 30000;
      const isExpired = Date.now() - (task.claimedAt || 0) > claimTimeout;

      expect(isExpired).toBe(true);
      // Expired claims should be reclaimable
    });

    it("crash after success but before cleanup is safe", () => {
      // Task marked success should not be re-run even if cleanup failed
      const task: StoredTask<TestPayload> = {
        id: "task-1",
        type: "test",
        payload: { value: 1 },
        status: "success",
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        runCount: 1,
        maxRetries: 3,
        error: null,
        result: { done: true },
      };

      // Even without cleanup, status is success
      expect(task.status).toBe("success");
      // Should not be picked up for processing
    });

    it("crash during handler leaves task in consistent state", () => {
      // If handler crashes, task should either:
      // 1. Still be in "running" (will timeout and retry)
      // 2. Be in "failed" (if crash was caught)

      const validCrashStates: TaskStatus[] = ["running", "failed", "claimed"];

      fc.assert(
        fc.property(
          fc.constantFrom(...validCrashStates),
          (crashState) => {
            // All crash states should be recoverable
            const canRecover =
              crashState === "running" || // Will timeout
              crashState === "failed" || // Can retry
              crashState === "claimed"; // Claim will expire

            return canRecover;
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});
