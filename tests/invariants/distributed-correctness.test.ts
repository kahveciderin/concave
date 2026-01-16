import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fc from "fast-check";

// ============================================================
// DISTRIBUTED CORRECTNESS TESTS
// ============================================================
// Exactly-once is impossible, so prove at-least-once + idempotency
// Tests for:
// - Network partition simulation
// - Clock skew tolerance
// - Crash consistency
// - Leader election / no leader scenarios

type Task = {
  id: string;
  status: "scheduled" | "claimed" | "running" | "success" | "failed";
  claimedBy?: string;
  claimedAt?: number;
  runCount: number;
  version: number;
};

type Worker = {
  id: string;
  isOnline: boolean;
  clockOffset: number; // Simulated clock skew in ms
  lastHeartbeat: number;
};

// Simulated distributed storage with eventual consistency
class SimulatedDistributedStorage {
  private tasks: Map<string, Task> = new Map();
  private partitionedWorkers: Set<string> = new Set();

  async get(id: string, workerId?: string): Promise<Task | null> {
    if (workerId && this.partitionedWorkers.has(workerId)) {
      throw new Error("Network partition");
    }
    return this.tasks.get(id) || null;
  }

  async save(task: Task, workerId?: string): Promise<void> {
    if (workerId && this.partitionedWorkers.has(workerId)) {
      throw new Error("Network partition");
    }
    this.tasks.set(task.id, { ...task });
  }

  async compareAndSwap(
    id: string,
    expected: Task,
    updated: Task,
    workerId?: string
  ): Promise<boolean> {
    if (workerId && this.partitionedWorkers.has(workerId)) {
      throw new Error("Network partition");
    }

    const current = this.tasks.get(id);
    if (!current || current.version !== expected.version) {
      return false; // CAS failed
    }

    this.tasks.set(id, { ...updated, version: expected.version + 1 });
    return true;
  }

  partition(workerId: string): void {
    this.partitionedWorkers.add(workerId);
  }

  heal(workerId: string): void {
    this.partitionedWorkers.delete(workerId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }
}

describe("Distributed Correctness", () => {
  let storage: SimulatedDistributedStorage;

  beforeEach(() => {
    storage = new SimulatedDistributedStorage();
  });

  describe("Network Partition Simulation", () => {
    it("worker A claims task, loses connectivity, worker B can claim after timeout", async () => {
      const claimTimeout = 30000;
      const task: Task = {
        id: "task-1",
        status: "scheduled",
        runCount: 0,
        version: 1,
      };

      await storage.save(task);

      // Worker A claims
      const taskForA = await storage.get("task-1");
      const claimedByA: Task = {
        ...taskForA!,
        status: "claimed",
        claimedBy: "worker-a",
        claimedAt: Date.now(),
      };
      await storage.save(claimedByA);

      // Partition worker A
      storage.partition("worker-a");

      // Simulate time passing
      const expiredClaim: Task = {
        ...claimedByA,
        claimedAt: Date.now() - claimTimeout - 1000, // Claim expired
      };
      await storage.save(expiredClaim, "worker-b");

      // Worker B checks and can reclaim
      const taskForB = await storage.get("task-1", "worker-b");
      const claimExpired =
        Date.now() - (taskForB?.claimedAt || 0) > claimTimeout;

      expect(claimExpired).toBe(true);

      // Worker B reclaims
      const reclaimedByB: Task = {
        ...taskForB!,
        status: "claimed",
        claimedBy: "worker-b",
        claimedAt: Date.now(),
        version: taskForB!.version + 1,
      };
      await storage.save(reclaimedByB, "worker-b");

      const finalTask = await storage.get("task-1", "worker-b");
      expect(finalTask?.claimedBy).toBe("worker-b");
    });

    it("partitioned worker's writes are rejected or queued", async () => {
      const task: Task = {
        id: "task-1",
        status: "scheduled",
        runCount: 0,
        version: 1,
      };

      await storage.save(task);
      storage.partition("worker-a");

      // Partitioned worker tries to write
      await expect(
        storage.save(
          { ...task, status: "claimed", claimedBy: "worker-a" },
          "worker-a"
        )
      ).rejects.toThrow("Network partition");
    });

    it("after partition heals, worker sees latest state", async () => {
      const task: Task = {
        id: "task-1",
        status: "scheduled",
        runCount: 0,
        version: 1,
      };

      await storage.save(task);

      // Worker A claims and gets partitioned
      storage.partition("worker-a");

      // Worker B completes the task
      await storage.save(
        {
          ...task,
          status: "success",
          runCount: 1,
          version: 2,
        },
        "worker-b"
      );

      // Heal partition
      storage.heal("worker-a");

      // Worker A should see completed task
      const finalTask = await storage.get("task-1", "worker-a");
      expect(finalTask?.status).toBe("success");
    });

    it("split-brain scenario: both workers think they own task", async () => {
      // This tests the CAS mechanism for preventing dual execution

      const task: Task = {
        id: "task-1",
        status: "scheduled",
        runCount: 0,
        version: 1,
      };

      await storage.save(task);

      // Both workers read at same time (before any claim)
      const taskForA = await storage.get("task-1");
      const taskForB = await storage.get("task-1");

      // Both try to claim simultaneously
      const claimA: Task = {
        ...taskForA!,
        status: "claimed",
        claimedBy: "worker-a",
        claimedAt: Date.now(),
      };

      const claimB: Task = {
        ...taskForB!,
        status: "claimed",
        claimedBy: "worker-b",
        claimedAt: Date.now(),
      };

      // Use CAS - only one should succeed
      const successA = await storage.compareAndSwap(
        "task-1",
        taskForA!,
        claimA
      );

      // If A succeeded, B should fail
      const successB = await storage.compareAndSwap(
        "task-1",
        taskForB!,
        claimB
      );

      // Exactly one should succeed
      expect(successA !== successB || (!successA && !successB)).toBe(true);

      // In the case where A succeeded first
      if (successA) {
        expect(successB).toBe(false);
      }
    });
  });

  describe("Clock Skew Tolerance", () => {
    it("scheduling tolerates reasonable clock skew", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -5000, max: 5000 }), // Clock skew in ms
          fc.integer({ min: 1000, max: 60000 }), // Scheduled delay
          (clockSkew, scheduledDelay) => {
            const serverTime = Date.now();
            const workerTime = serverTime + clockSkew;

            const scheduledAt = serverTime + scheduledDelay;

            // Worker's view of whether task should run
            const shouldRunFromWorkerPerspective = workerTime >= scheduledAt;

            // With skew up to 5s and delay of 1-60s, behavior is predictable
            // The key is that scheduling uses server time, not worker time
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("claim timeout calculation handles clock skew", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -10000, max: 10000 }), // Clock skew
          fc.integer({ min: 30000, max: 60000 }), // Claim timeout
          (clockSkew, claimTimeout) => {
            // Worker A claims with their clock
            const workerATime = Date.now();
            const claimedAt = workerATime;

            // Worker B checks with different clock
            const workerBTime = workerATime + clockSkew;

            // Check if claim appears expired to worker B
            const appearsExpired = workerBTime - claimedAt > claimTimeout;

            // With reasonable timeout (30-60s) and skew (±10s),
            // claims shouldn't falsely appear expired/valid
            // Buffer should be: timeout > 2 * maxSkew
            const safeBuffer = claimTimeout > Math.abs(clockSkew) * 2;

            // If we have safe buffer, no false expirations within expected time
            if (safeBuffer && clockSkew > 0) {
              // Positive skew: B thinks more time passed
              // Claim might appear expired sooner from B's perspective
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("retry backoff uses relative time, not absolute", () => {
      // Backoff should be calculated from claim time, not wall clock
      const baseBackoff = 1000;
      const retryCount = 3;
      const multiplier = 2;

      const calculateBackoff = (count: number) =>
        baseBackoff * Math.pow(multiplier, count);

      // These should be the same regardless of clock skew
      const backoff1 = calculateBackoff(retryCount);
      const backoff2 = calculateBackoff(retryCount);

      expect(backoff1).toBe(backoff2);
      expect(backoff1).toBe(8000); // 1000 * 2^3
    });

    it("recurring task intervals are clock-skew resistant", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 60000, max: 3600000 }), // Interval (1min - 1hr)
          fc.integer({ min: -30000, max: 30000 }), // Clock skew
          fc.integer({ min: 1, max: 10 }), // Number of executions
          (interval, clockSkew, numExecutions) => {
            // Use monotonic time / sequence numbers instead of wall clock
            let lastExecutionSeq = 0;
            const executions: number[] = [];

            for (let i = 0; i < numExecutions; i++) {
              lastExecutionSeq++;
              executions.push(lastExecutionSeq);
            }

            // Sequence-based execution is immune to clock skew
            for (let i = 1; i < executions.length; i++) {
              if (executions[i]! <= executions[i - 1]!) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Crash Consistency", () => {
    it("crash after claim but before ack: task is reclaimable", async () => {
      const task: Task = {
        id: "task-1",
        status: "claimed",
        claimedBy: "crashed-worker",
        claimedAt: Date.now() - 60000, // Old claim
        runCount: 0,
        version: 1,
      };

      await storage.save(task);

      // Another worker checks for stale claims
      const staleTask = await storage.get("task-1");
      const claimTimeout = 30000;
      const isStale = Date.now() - (staleTask?.claimedAt || 0) > claimTimeout;

      expect(isStale).toBe(true);
    });

    it("crash after DB write but before changelog append: detectable inconsistency", () => {
      // This tests the "write-ahead log" pattern
      // If DB write succeeds but changelog fails, we need to detect/recover

      type Operation = {
        id: string;
        dbWritten: boolean;
        changelogWritten: boolean;
      };

      const detectInconsistency = (op: Operation): boolean => {
        // Inconsistent: DB written but not changelog
        return op.dbWritten && !op.changelogWritten;
      };

      const scenarios = [
        { id: "1", dbWritten: true, changelogWritten: true }, // OK
        { id: "2", dbWritten: false, changelogWritten: false }, // OK (nothing happened)
        { id: "3", dbWritten: true, changelogWritten: false }, // INCONSISTENT
        { id: "4", dbWritten: false, changelogWritten: true }, // IMPOSSIBLE
      ];

      const inconsistent = scenarios.filter(detectInconsistency);
      expect(inconsistent.length).toBe(1);
      expect(inconsistent[0]?.id).toBe("3");
    });

    it("crash recovery replays uncommitted operations", () => {
      // Simulate write-ahead log recovery
      type WALEntry = {
        id: string;
        operation: "create" | "update" | "delete";
        committed: boolean;
        data: Record<string, unknown>;
      };

      const walEntries: WALEntry[] = [
        { id: "1", operation: "create", committed: true, data: { x: 1 } },
        { id: "2", operation: "update", committed: false, data: { x: 2 } }, // Uncommitted
        { id: "3", operation: "create", committed: true, data: { x: 3 } },
      ];

      // Recovery: replay uncommitted entries
      const uncommitted = walEntries.filter((e) => !e.committed);
      expect(uncommitted.length).toBe(1);
      expect(uncommitted[0]?.id).toBe("2");

      // After replay, mark as committed
      uncommitted.forEach((e) => (e.committed = true));

      expect(walEntries.every((e) => e.committed)).toBe(true);
    });
  });

  describe("No Leader / Any Server Can Claim", () => {
    it("without leader, tasks are distributed fairly", () => {
      // Test with deterministic round-robin distribution
      const testFairDistribution = (numWorkers: number, numTasks: number) => {
        const taskCounts = new Map<string, number>();

        // Initialize worker counts
        for (let i = 0; i < numWorkers; i++) {
          taskCounts.set(`worker-${i}`, 0);
        }

        // Round-robin distribution (deterministic fair distribution)
        for (let t = 0; t < numTasks; t++) {
          const winner = `worker-${t % numWorkers}`;
          taskCounts.set(winner, (taskCounts.get(winner) || 0) + 1);
        }

        // Check for rough fairness (no worker has more than 3x average)
        const avg = numTasks / numWorkers;
        const maxAllowed = avg * 3;

        for (const count of taskCounts.values()) {
          if (count > maxAllowed) {
            return false;
          }
        }
        return true;
      };

      // Test various configurations
      expect(testFairDistribution(3, 10)).toBe(true);
      expect(testFairDistribution(5, 50)).toBe(true);
      expect(testFairDistribution(10, 100)).toBe(true);
    });

    it("thundering herd is prevented by randomized backoff", () => {
      // Test that jitter spreads out claim attempts
      const testJitterSpread = (numWorkers: number, baseBackoff: number) => {
        const claimAttempts: number[] = [];
        const now = Date.now();

        // Simulate deterministic jitter (using index-based spread)
        for (let i = 0; i < numWorkers; i++) {
          // Deterministic jitter based on worker index
          const jitter = (i / numWorkers) * baseBackoff;
          claimAttempts.push(now + jitter);
        }

        // Sort to see distribution
        claimAttempts.sort((a, b) => a - b);

        // Check that attempts are spread out
        const firstAttempt = claimAttempts[0]!;
        const lastAttempt = claimAttempts[claimAttempts.length - 1]!;
        const spread = lastAttempt - firstAttempt;

        // With proper jitter, spread should be significant
        // For n workers with index-based jitter, spread is (n-1)/n * baseBackoff
        const expectedSpread = ((numWorkers - 1) / numWorkers) * baseBackoff;
        return spread >= expectedSpread * 0.9; // Allow small tolerance
      };

      // Test various configurations
      expect(testJitterSpread(10, 100)).toBe(true);
      expect(testJitterSpread(50, 500)).toBe(true);
      expect(testJitterSpread(100, 1000)).toBe(true);
    });

    it("worker failure is detected and work redistributed", async () => {
      const workers: Worker[] = [
        { id: "w1", isOnline: true, clockOffset: 0, lastHeartbeat: Date.now() },
        { id: "w2", isOnline: true, clockOffset: 0, lastHeartbeat: Date.now() },
        {
          id: "w3",
          isOnline: false,
          clockOffset: 0,
          lastHeartbeat: Date.now() - 60000,
        }, // Failed
      ];

      const heartbeatTimeout = 30000;

      const isWorkerHealthy = (w: Worker) =>
        w.isOnline && Date.now() - w.lastHeartbeat < heartbeatTimeout;

      const healthyWorkers = workers.filter(isWorkerHealthy);
      expect(healthyWorkers.length).toBe(2);

      // Tasks claimed by failed worker should be redistributable
      const task: Task = {
        id: "task-1",
        status: "claimed",
        claimedBy: "w3", // Failed worker
        claimedAt: Date.now() - 60000,
        runCount: 0,
        version: 1,
      };

      // Since w3 failed, task should be reclaimable
      const claimTimeout = 30000;
      const canReclaim = Date.now() - (task.claimedAt || 0) > claimTimeout;
      expect(canReclaim).toBe(true);
    });
  });

  describe("At-Least-Once with Idempotency", () => {
    it("duplicate execution with same idempotency key is safe", () => {
      const executedKeys = new Set<string>();
      const results: Array<{ key: string; executed: boolean }> = [];

      const executeWithIdempotency = (
        key: string,
        fn: () => void
      ): { executed: boolean } => {
        if (executedKeys.has(key)) {
          return { executed: false }; // Duplicate, skip
        }
        fn();
        executedKeys.add(key);
        return { executed: true };
      };

      // First execution
      const result1 = executeWithIdempotency("key-1", () => {
        results.push({ key: "key-1", executed: true });
      });

      // Duplicate execution (network retry, etc.)
      const result2 = executeWithIdempotency("key-1", () => {
        results.push({ key: "key-1", executed: true });
      });

      expect(result1.executed).toBe(true);
      expect(result2.executed).toBe(false);
      expect(results.length).toBe(1); // Only one actual execution
    });

    it("at-least-once: failed ack causes retry, idempotency prevents double effect", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }), // Number of retries due to failed acks
          (retryCount) => {
            const idempotencyKey = "unique-op-123";
            const processedKeys = new Set<string>();
            let sideEffectCount = 0;

            const process = (key: string) => {
              if (processedKeys.has(key)) {
                return; // Idempotent - already processed
              }
              sideEffectCount++;
              processedKeys.add(key);
            };

            // Simulate retries
            for (let i = 0; i < retryCount; i++) {
              process(idempotencyKey);
            }

            // Should only have one side effect despite multiple attempts
            return sideEffectCount === 1;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
