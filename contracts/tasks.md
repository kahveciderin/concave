# Task Contracts

## Guarantees

### Execution Semantics
- **At-least-once execution**: Every scheduled task will be attempted at least once (unless cancelled)
- **Idempotency key respect**: Tasks with same idempotency key execute at most once within TTL
- **State machine validity**: Tasks only transition through valid states:
  ```
  scheduled → claimed → running → success|failed|retry
  failed → dlq|retry|scheduled
  retry → scheduled
  dlq → scheduled (replay)
  ```

### Retry Behavior
- **Bounded retries**: Tasks retry up to `maxRetries` times before going to DLQ
- **Exponential backoff**: Retry delays increase exponentially with configurable base and multiplier
- **Jitter**: Retry times include random jitter to prevent thundering herd

### Claim/Lease
- **Exclusive execution**: Only one worker executes a task at a time (via claim mechanism)
- **Claim expiration**: If worker dies, claim expires after timeout, allowing reclaim
- **No dual execution**: CAS operations prevent split-brain dual execution

### Recurring Tasks
- **Scheduled execution**: Recurring tasks execute at specified intervals
- **No pile-up**: Missed executions during downtime don't cause burst of catchup runs
- **Drift control**: Fixed-rate vs fixed-delay semantics are explicit and honored

## Non-Guarantees

### Timing (What We Don't Promise)
- ❌ **Exact execution time**: Tasks execute "around" scheduled time, not precisely at it
- ❌ **Order preservation**: Tasks scheduled at same time may execute in any order
- ❌ **Clock accuracy**: System depends on reasonable clock accuracy (±seconds, not milliseconds)

### Execution (What We Don't Promise)
- ❌ **Exactly-once**: We provide at-least-once; idempotency is caller's responsibility
- ❌ **Execution duration limits**: Tasks can run indefinitely (unless timeout configured)
- ❌ **Result persistence**: Task results are not permanently stored by default

### Distributed (What We Don't Promise)
- ❌ **Fair distribution**: Work distribution across workers is best-effort, not guaranteed fair
- ❌ **Affinity**: Same task may execute on different workers across retries

## Failure Modes

### Worker Crash During Execution
- Task remains in `claimed` or `running` state
- Claim expires after timeout
- Another worker reclaims and retries
- `runCount` is incremented for retry tracking

### Database Unavailable
- Task scheduling fails (reported to caller)
- Running tasks may fail to update status
- On recovery, orphaned claims are reclaimed

### Poison Pill (Always-Failing Task)
- Retries up to `maxRetries`
- Moves to DLQ after exhausting retries
- Does NOT block other tasks in queue
- DLQ can be replayed with new idempotency key

### Clock Skew Between Workers
- Claim timeouts account for reasonable skew (recommended: timeout > 2× max skew)
- Scheduling uses server time, not worker time
- Backoff calculations use relative time

## Test Coverage

- `tests/invariants/task-state-machine.test.ts` - State machine invariants
- `tests/invariants/distributed-correctness.test.ts` - Distributed scenarios
- `tests/tasks/worker.test.ts` - Worker behavior
- `tests/tasks/scheduler.test.ts` - Scheduling
- `tests/tasks/retry.test.ts` - Retry logic
- `tests/tasks/dlq.test.ts` - Dead letter queue
- `tests/tasks/recurring.test.ts` - Recurring tasks
