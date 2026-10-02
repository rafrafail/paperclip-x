import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  decisionQueues,
  financeEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent remove run-reference tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.remove heartbeat run references", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-run-refs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(decisionQueues);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("detaches finance, cost and decision-queue rows from the agent's runs before deleting them", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await insertAgent(companyId, "RetiredWorker");
    const billingAgentId = await insertAgent(companyId, "BillingOwner");

    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue touched by a retired worker",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    const costEventId = randomUUID();
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId: billingAgentId,
      issueId,
      heartbeatRunId: runId,
      provider: "openai",
      model: "gpt-test",
      costCents: 42,
      occurredAt: new Date(),
    });
    const financeEventId = randomUUID();
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      issueId,
      heartbeatRunId: runId,
      costEventId,
      eventKind: "inference_charge",
      biller: "openai",
      amountCents: 42,
      occurredAt: new Date(),
    });
    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "retired-worker-queue",
      title: "Queue created during a run",
      createdByType: "system",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).resolves.toHaveLength(0);

    const [cost] = await db.select().from(costEvents).where(eq(costEvents.id, costEventId));
    expect(cost).toMatchObject({ heartbeatRunId: null, costCents: 42, issueId });
    const [finance] = await db.select().from(financeEvents).where(eq(financeEvents.id, financeEventId));
    expect(finance).toMatchObject({ heartbeatRunId: null, costEventId, amountCents: 42 });
    const [queue] = await db.select().from(decisionQueues).where(eq(decisionQueues.id, queueId));
    expect(queue?.createdByRunId).toBeNull();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ id: issueId, title: "Issue touched by a retired worker", assigneeAgentId: null });
  });
});
