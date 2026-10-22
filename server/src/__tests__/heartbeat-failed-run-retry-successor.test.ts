import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: vi.fn() };
});

import {
  FAILED_RUN_RETRY_SUCCESSOR_REPLAY_VERSION,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

// Real embedded Postgres, the real locked admission transaction
// (heartbeat.wakeup → enqueueWakeup) and the real bounded-retry scheduler.
// Only telemetry is stubbed. A busy "running" slot (maxConcurrentRuns: 1)
// keeps every admitted run queued so no adapter process is ever spawned.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres failed-run retry successor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("exact failed-run retry shares the single retry successor", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-failed-run-retry-successor-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issues);
    await db.update(heartbeatRuns).set({ retryOfRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { issueStatus?: string; failedStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agent = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agents).values([agent(agentId, "Reviewer"), agent(otherAgentId, "Other")]);
    // Occupy the only slot of each agent: admitted runs stay queued.
    await db.insert(heartbeatRuns).values([agentId, otherAgentId].map((id) => ({
      id: randomUUID(),
      companyId,
      agentId: id,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    })));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Independent re-review",
      status: input.issueStatus ?? "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const finishedAt = new Date(Date.now() - 120_000);
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: input.failedStatus ?? "timed_out",
      error: "Timed out",
      errorCode: "timeout",
      startedAt: finishedAt,
      finishedAt,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      createdAt: finishedAt,
      updatedAt: finishedAt,
    });
    return { companyId, agentId, otherAgentId, issueId, failedRunId };
  }

  // Mirrors POST /api/agents/:id/wakeup for a non-chat Board failed-run retry
  // (routes/agents.ts): server-derived payload, user actor, manual trigger.
  function boardRetry(fixture: { agentId: string; issueId: string }, failedRunId: string) {
    return heartbeat.wakeup(fixture.agentId, {
      failedRunId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId: fixture.issueId, taskId: fixture.issueId },
      idempotencyKey: "goal:7:retry",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        responsibleUserId: "local-board",
        forceFreshSession: false,
      },
    });
  }

  async function successors(failedRunId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failedRunId));
  }

  async function counts() {
    const [runs, wakes] = await Promise.all([
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns),
      db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests),
    ]);
    return { runs: runs.length, wakes: wakes.length };
  }

  it("publishes a versioned replay capability constant", () => {
    expect(FAILED_RUN_RETRY_SUCCESSOR_REPLAY_VERSION).toBe(1);
  });

  it.each(["scheduled_retry", "queued", "running", "failed", "succeeded", "cancelled"])(
    "native successor first (%s, delay elapsed): exact retry adopts it with no new run or wake",
    async (status) => {
      const fixture = await seed();
      const scheduled = await heartbeat.scheduleBoundedRetry(fixture.failedRunId, {
        now: new Date(Date.now() - 60_000),
        random: () => 0,
      });
      expect(scheduled).toMatchObject({ outcome: "scheduled" });
      if (scheduled.outcome !== "scheduled" || !scheduled.run) throw new Error("Expected native successor");
      expect(scheduled.run).toMatchObject({
        status: "scheduled_retry",
        retryOfRunId: fixture.failedRunId,
        scheduledRetryReason: "transient_failure",
      });
      if (status !== "scheduled_retry") {
        await db.update(heartbeatRuns).set({
          status,
          ...(["failed", "succeeded", "cancelled"].includes(status) ? { finishedAt: new Date() } : {}),
          ...(status === "running" ? { startedAt: new Date() } : {}),
        }).where(eq(heartbeatRuns.id, scheduled.run.id));
      }
      const before = await counts();

      const adopted = await boardRetry(fixture, fixture.failedRunId);

      expect(adopted?.id).toBe(scheduled.run.id);
      expect(adopted?.status).toBe(status);
      expect(await counts()).toEqual(before);
      expect((await successors(fixture.failedRunId)).map((row) => row.id)).toEqual([scheduled.run.id]);
    },
  );

  it("exact retry first: every automatic scheduler observes it and adds no successor", async () => {
    const fixture = await seed({ issueStatus: "in_progress" });
    const ours = await boardRetry(fixture, fixture.failedRunId);
    expect(ours).toMatchObject({
      status: "queued",
      retryOfRunId: fixture.failedRunId,
      invocationSource: "on_demand",
      scheduledRetryReason: null,
    });
    const generic = await heartbeat.scheduleBoundedRetry(fixture.failedRunId, { now: new Date(), random: () => 0 });
    expect(generic).toMatchObject({ outcome: "scheduled", run: { id: ours!.id } });
    // The interaction-continuation lane has its own dedupe and previously
    // inserted a second successor beside an existing exact retry.
    await heartbeat.scheduleBoundedRetry(fixture.failedRunId, {
      now: new Date(),
      random: () => 0,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: "interaction_continuation_infra_retry",
      maxAttempts: 2,
    });
    expect((await successors(fixture.failedRunId)).map((row) => row.id)).toEqual([ours!.id]);
  });

  it("concurrent and repeated retransmission resolve to the exact same single successor", async () => {
    const fixture = await seed();
    const concurrent = await Promise.all([
      boardRetry(fixture, fixture.failedRunId),
      boardRetry(fixture, fixture.failedRunId),
      heartbeat.scheduleBoundedRetry(fixture.failedRunId, { now: new Date(), random: () => 0 }),
    ]);
    const rows = await successors(fixture.failedRunId);
    expect(rows).toHaveLength(1);
    const before = await counts();
    const again = await boardRetry(fixture, fixture.failedRunId);
    expect(again?.id).toBe(rows[0]!.id);
    expect(concurrent[0]?.id).toBe(rows[0]!.id);
    expect(concurrent[1]?.id).toBe(rows[0]!.id);
    expect(await counts()).toEqual(before);
  });

  it("ignores a successor of an unrelated failed run", async () => {
    const fixture = await seed();
    const unrelatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unrelatedRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "timeout",
      finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId },
    });
    const unrelated = await heartbeat.scheduleBoundedRetry(unrelatedRunId, { now: new Date(), random: () => 0 });
    expect(unrelated).toMatchObject({ outcome: "scheduled" });
    // Terminal, so issue-level admission has no execution path to coalesce
    // into; only the successor predicate could (wrongly) select it.
    if (unrelated.outcome !== "scheduled" || !unrelated.run) throw new Error("Expected unrelated successor");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, unrelated.run.id));

    const ours = await boardRetry(fixture, fixture.failedRunId);

    expect(ours).toMatchObject({ retryOfRunId: fixture.failedRunId, invocationSource: "on_demand" });
    expect(ours?.id).not.toBe(unrelated.outcome === "scheduled" ? unrelated.run?.id : null);
    expect(await successors(fixture.failedRunId)).toHaveLength(1);
  });

  it("rejects a retry when the failed run's successor belongs to another agent", async () => {
    const fixture = await seed();
    const foreignId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: foreignId,
      companyId: fixture.companyId,
      agentId: fixture.otherAgentId,
      invocationSource: "automation",
      status: "queued",
      retryOfRunId: fixture.failedRunId,
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId },
    });
    const before = await counts();

    await expect(boardRetry(fixture, fixture.failedRunId)).rejects.toMatchObject({ status: 409 });

    expect(await counts()).toEqual(before);
    expect((await successors(fixture.failedRunId)).map((row) => row.id)).toEqual([foreignId]);
  });

  it("still refuses a succeeded run even when it has a successor", async () => {
    const fixture = await seed({ failedStatus: "succeeded" });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      status: "queued",
      retryOfRunId: fixture.failedRunId,
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId },
    });
    const before = await counts();

    await expect(boardRetry(fixture, fixture.failedRunId)).rejects.toMatchObject({ status: 409 });

    expect(await counts()).toEqual(before);
  });

  // B1-residual: an exact retry admitted while UNRELATED execution owns the
  // issue must be refused outright, never coalesced into that run or deferred
  // and later promoted without its retryOfRunId identity.
  async function unrelatedExecution(
    fixture: Awaited<ReturnType<typeof seed>>,
    input: { status: "queued" | "running"; agentId?: string; holdsLock?: boolean },
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: fixture.companyId,
      agentId: input.agentId ?? fixture.agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: input.status,
      ...(input.status === "running" ? { startedAt: new Date() } : {}),
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_commented" },
    });
    if (input.holdsLock) {
      await db.update(issues).set({
        executionRunId: id,
        executionAgentNameKey: input.agentId === fixture.otherAgentId ? "other" : "reviewer",
        executionLockedAt: new Date(),
      }).where(eq(issues.id, fixture.issueId));
    }
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return row!;
  }

  async function retryWakeRows() {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "retry_failed_run"));
  }

  async function expectRejectedWithoutSideEffects(
    fixture: Awaited<ReturnType<typeof seed>>,
    unrelated: typeof heartbeatRuns.$inferSelect,
  ) {
    const before = await counts();
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));

    await expect(boardRetry(fixture, fixture.failedRunId)).rejects.toMatchObject({
      status: 409,
      details: { code: "failed_run_retry_issue_busy", activeRunId: unrelated.id },
    });

    expect(await counts()).toEqual(before);
    expect(await retryWakeRows()).toEqual([]);
    expect(await successors(fixture.failedRunId)).toEqual([]);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id));
    expect({ status: after!.status, contextSnapshot: after!.contextSnapshot, agentId: after!.agentId })
      .toEqual({ status: unrelated.status, contextSnapshot: unrelated.contextSnapshot, agentId: unrelated.agentId });
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect({ executionRunId: issueAfter!.executionRunId, status: issueAfter!.status })
      .toEqual({ executionRunId: issueBefore!.executionRunId, status: issueBefore!.status });
  }

  it.each([
    ["queued without the lock (lazy locking)", { status: "queued" as const }],
    ["running and holding the lock", { status: "running" as const, holdsLock: true }],
  ])("rejects an exact retry behind unrelated same-agent issue execution %s", async (_name, input) => {
    const fixture = await seed();
    const unrelated = await unrelatedExecution(fixture, input);
    await expectRejectedWithoutSideEffects(fixture, unrelated);
  });

  it("rejects behind another agent's live issue execution and never promotes it later", async () => {
    const fixture = await seed();
    const unrelated = await unrelatedExecution(fixture, {
      status: "running", agentId: fixture.otherAgentId, holdsLock: true,
    });
    await expectRejectedWithoutSideEffects(fixture, unrelated);

    // Real finalize → release → deferred-wake promotion path.
    await heartbeat.cancelRun(unrelated.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await retryWakeRows()).toEqual([]);
    const reviewerRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixture.agentId));
    expect(reviewerRuns.filter((row) => row.contextSnapshot?.issueId === fixture.issueId).map((row) => row.id))
      .toEqual([fixture.failedRunId]);
  });

  it("late admission behind an ordinary wake that already queued unrelated work is refused", async () => {
    const fixture = await seed();
    const ordinary = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: { issueId: fixture.issueId, taskId: fixture.issueId },
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(ordinary).toMatchObject({ status: "queued", retryOfRunId: null });
    await expectRejectedWithoutSideEffects(fixture, ordinary!);
  });

  it("parallel ordinary wake and exact retry never yield an unlinked retry execution", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fixture = await seed();
      const [ordinary, retry] = await Promise.allSettled([
        heartbeat.wakeup(fixture.agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_assigned",
          payload: { issueId: fixture.issueId, taskId: fixture.issueId },
          contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" },
          requestedByActorType: "user",
          requestedByActorId: "local-board",
        }),
        boardRetry(fixture, fixture.failedRunId),
      ]);
      expect(ordinary.status).toBe("fulfilled");
      if (retry.status === "fulfilled") {
        // Retry admitted first: it is the one linked successor; the ordinary
        // wake was then admitted behind or into it by the usual policy.
        expect(retry.value?.retryOfRunId).toBe(fixture.failedRunId);
      } else {
        expect(retry.reason).toMatchObject({ status: 409, details: { code: "failed_run_retry_issue_busy" } });
      }
      expect((await retryWakeRows()).filter((row) => row.status === "deferred_issue_execution")).toEqual([]);
      expect((await successors(fixture.failedRunId)).length).toBeLessThanOrEqual(1);
    }
  });

  it("still adopts the existing successor idempotently while the issue is busy", async () => {
    const fixture = await seed();
    const scheduled = await heartbeat.scheduleBoundedRetry(fixture.failedRunId, { now: new Date(), random: () => 0 });
    if (scheduled.outcome !== "scheduled" || !scheduled.run) throw new Error("Expected native successor");
    await unrelatedExecution(fixture, { status: "running", agentId: fixture.otherAgentId, holdsLock: true });
    const before = await counts();

    const first = await boardRetry(fixture, fixture.failedRunId);
    const second = await boardRetry(fixture, fixture.failedRunId);

    expect([first?.id, second?.id]).toEqual([scheduled.run.id, scheduled.run.id]);
    expect(await counts()).toEqual(before);
  });

  it("exact retry first: the max-turn lane adds no second successor", async () => {
    const fixture = await seed({ issueStatus: "in_progress" });
    const ours = await boardRetry(fixture, fixture.failedRunId);
    expect(ours).toMatchObject({ retryOfRunId: fixture.failedRunId });
    await heartbeat.scheduleBoundedRetry(fixture.failedRunId, {
      now: new Date(),
      random: () => 0,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 0,
    });
    expect((await successors(fixture.failedRunId)).map((row) => row.id)).toEqual([ours!.id]);
  });
});
