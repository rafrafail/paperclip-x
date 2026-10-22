import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

// The exact HTTP route POST /api/agents/:id/wakeup on a disposable real app
// (createApp, local_trusted board actor) and a disposable embedded Postgres.
// No live service, product card or adapter process is involved: the fixture
// rows are inserted directly and the issue stays busy with unrelated work.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("POST /api/agents/:id/wakeup exact failed-run retry", () => {
  let server!: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  async function seed() {
    const { db } = server;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const failedRunId = randomUUID(), unrelatedRunId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Route fixture", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Re-review", status: "blocked", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    const finishedAt = new Date(Date.now() - 120_000);
    await db.insert(heartbeatRuns).values([{
      id: failedRunId, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual",
      status: "timed_out", errorCode: "timeout", startedAt: finishedAt, finishedAt,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" }, createdAt: finishedAt,
    }, {
      // Unrelated work admitted after the client's last read: queued and
      // lazily locked, so only the issue-scoped execution path names it.
      id: unrelatedRunId, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual",
      status: "queued", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    }]);
    return { companyId, agentId, issueId, failedRunId, unrelatedRunId };
  }

  it("answers 409 failed_run_retry_issue_busy and writes no wake or run", async () => {
    const fixture = await seed();
    const response = await fetch(`${server.apiUrl}/api/agents/${fixture.agentId}/wakeup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
        failedRunId: fixture.failedRunId, idempotencyKey: "goal:7:retry",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ details: { code: "failed_run_retry_issue_busy", activeRunId: fixture.unrelatedRunId } });
    const { db } = server;
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.agentId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.failedRunId))).toEqual([]);
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixture.agentId));
    expect(runs.map((row) => row.id).sort()).toEqual([fixture.failedRunId, fixture.unrelatedRunId].sort());
  });
});
