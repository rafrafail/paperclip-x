import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn(async () => ({ allowed: true })) }));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  createRecorder: vi.fn(),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
  reconcileStaleRuntimeControlControlOperations: vi.fn(),
  listForExecutionWorkspace: vi.fn(async () => []),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", async () => {
  const realExecutionWorkspaces = await import("../services/execution-workspaces.js");
  const leases = await import("../services/workspace-runtime-leases.js");
  return {
    accessService: () => mockAccessService,
    // The registration route persists through the real service so the SQL,
    // advisory lock and idempotent re-check are exercised for real.
    executionWorkspaceService: (db: unknown) => realExecutionWorkspaces.executionWorkspaceService(db),
    heartbeatService: () => ({}),
    logActivity: mockLogActivity,
    workspaceOperationService: () => mockWorkspaceOperationService,
    workspaceRuntimeLeaseService: leases.workspaceRuntimeLeaseService,
    LEASED_WORKSPACE_RUNTIME_ACTIONS: leases.LEASED_WORKSPACE_RUNTIME_ACTIONS,
  };
});

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ destroyReusableSandboxLeases: vi.fn() }),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: () => ({ desiredState: "running", serviceStates: null }),
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  listConfiguredRuntimeServiceEntries: () => [],
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: vi.fn(),
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping prepared execution workspace registration route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REPO_URL = "https://github.com/rafrafail/xd-gaming.git";
const CANDIDATE_SHA = "43a06330f967b414d856125ef8f2ac3baf9cbbd3";

describeEmbeddedPostgres("prepared execution workspace registration route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let projectId = "";
  let primaryWorkspaceId = "";
  let repoRoot = "";
  let preparedCwd = "";
  let preparedDir = "";
  let app: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-register-prepared-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (preparedDir) rmSync(preparedDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true } as never);

    companyId = randomUUID();
    projectId = randomUUID();
    primaryWorkspaceId = randomUUID();
    // A disposable on-disk tree shaped like a project repository: the primary
    // checkout is the repository root and the prepared review checkout lives
    // strictly inside the repository's own _work/ tree. The fixture paths are
    // canonicalized because the route registers prepared cwds in canonical,
    // symlink-resolved form (tmpdir() itself can be a symlink on some hosts).
    preparedDir = realpathSync(mkdtempSync(path.join(tmpdir(), "register-prepared-repo-")));
    repoRoot = preparedDir;
    preparedCwd = path.join(repoRoot, "_work", "pr27-final-review");
    mkdirSync(preparedCwd, { recursive: true });

    await db.insert(companies).values({
      id: companyId,
      name: "Prepared registration",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "XD", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: primaryWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      isPrimary: true,
      cwd: repoRoot,
      repoUrl: REPO_URL,
    });

    const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/execution-workspaces.js"),
      import("../middleware/index.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db as never));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    if (preparedDir) rmSync(preparedDir, { recursive: true, force: true });
  });

  function registerPayload(overrides: Record<string, unknown> = {}) {
    return {
      cwd: preparedCwd,
      repoUrl: REPO_URL,
      baseRef: CANDIDATE_SHA,
      ...overrides,
    };
  }

  it("registers a prepared detached workspace with the exact identity and audits the action", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      projectId,
      projectWorkspaceId: primaryWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      providerType: "git_worktree",
      status: "idle",
      cwd: preparedCwd,
      providerRef: preparedCwd,
      repoUrl: REPO_URL,
      baseRef: CANDIDATE_SHA,
      branchName: null,
      closedAt: null,
    });
    expect(res.body.metadata?.workspaceRealization).toEqual({
      authoritativeRoot: preparedCwd,
      local: { path: preparedCwd, worktreePath: preparedCwd },
    });
    expect(res.body.metadata?.workspaceRealizationRequest).toEqual({
      source: { localPath: preparedCwd, worktreePath: preparedCwd },
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "execution_workspace.registered_prepared",
        entityType: "execution_workspace",
        entityId: res.body.id,
        details: expect.objectContaining({ idempotent: false, baseRef: CANDIDATE_SHA }),
      }),
    );
  });

  it("is idempotent: the same registration returns the existing record without a duplicate row", async () => {
    const first = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const rows = await db.select().from(executionWorkspaces);
    expect(rows.filter((row) => row.cwd === preparedCwd)).toHaveLength(1);
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ idempotent: true }),
      }),
    );
  });

  it("rejects an existing record for the same cwd with a different identity as a conflict", async () => {
    await db.insert(executionWorkspaces).values({
      companyId,
      projectId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Stale prepared row",
      status: "active",
      cwd: preparedCwd,
      repoUrl: REPO_URL,
      baseRef: "0f0e0d0c0b0a0908070605040302010011223344",
      branchName: "some-branch",
      providerType: "git_worktree",
      providerRef: preparedCwd,
    });
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("different identity");
    expect(res.body.conflict).toMatchObject({ branchName: "some-branch" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("fails closed for a cwd outside the project's own _work tree", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "register-prepared-outside-"));
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: outside }));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("strictly inside");
    const primaryItself = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: repoRoot }));
    expect(primaryItself.status).toBe(422);
    const workRootItself = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: path.join(repoRoot, "_work") }));
    expect(workRootItself.status).toBe(422);
  });

  it("fails closed when the repoUrl was not deliberately reconciled with the project primary workspace", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ repoUrl: "git@github.com:rafrafail/xd-gaming.git" }));
    expect(res.status).toBe(422);
    expect(res.body.expectedRepoUrl).toBe(REPO_URL);
    expect(res.body.receivedRepoUrl).toBe("git@github.com:rafrafail/xd-gaming.git");
  });

  it("fails closed when the prepared path does not exist on the server host", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: path.join(repoRoot, "_work", "never-prepared") }));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("does not exist");
  });

  it("rejects a non-hex or non-lowercase baseRef, extra keys and relative paths at validation", async () => {
    const uppercase = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ baseRef: CANDIDATE_SHA.toUpperCase() }));
    expect(uppercase.status).toBe(400);
    const short = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ baseRef: "deadbeef" }));
    expect(short.status).toBe(400);
    const extraKey = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ branchName: "sneaky" }));
    expect(extraKey.status).toBe(400);
    const metadataKey = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ metadata: { anything: true } }));
    expect(metadataKey.status).toBe(400);
    const relative = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: "relative/_work/review" }));
    expect(relative.status).toBe(400);
    const traversal = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: `${repoRoot}/_work/../_work/review` }));
    expect(traversal.status).toBe(400);
  });

  it("denies actors outside the runtime:manage authorization boundary", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false } as never);
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(403);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("hides projects from other companies behind a uniform 404", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Elsewhere",
      issuePrefix: `E${otherCompanyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const otherProjectId = randomUUID();
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "Other", status: "in_progress" });
    const res = await request(app)
      .post(`/api/projects/${otherProjectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(404);
  });

  it("requires a single primary workspace carrying cwd and repoUrl", async () => {
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "Second primary",
      isPrimary: true,
      cwd: repoRoot,
      repoUrl: REPO_URL,
    });
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("single primary workspace");
  });

  it("rejects a prepared cwd whose final segment is a symlink escaping the project work root", async () => {
    // `_work/linked-outside` is spelled inside the work tree but resolves to a
    // directory outside it: the boundary must be enforced on the canonical
    // path, not the lexical spelling.
    const outsideWork = path.join(repoRoot, "outside-work");
    mkdirSync(outsideWork);
    const link = path.join(repoRoot, "_work", "linked-outside");
    symlinkSync(outsideWork, link, "dir");
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: link }));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("strictly inside");
    const rows = await db.select().from(executionWorkspaces);
    expect(rows.filter((row) => row.cwd === link)).toHaveLength(0);
  });

  it("rejects a prepared cwd reached through a symlinked ancestor escaping the project work root", async () => {
    // The final segment is a real directory, but an ancestor on the path is a
    // symlink pointing outside the project tree: lexical containment holds
    // while canonical containment does not.
    const otherTree = mkdtempSync(path.join(tmpdir(), "register-prepared-other-"));
    const realPrepared = path.join(otherTree, "smuggled-review");
    mkdirSync(realPrepared, { recursive: true });
    const aliasedWork = path.join(repoRoot, "_work", "aliased");
    symlinkSync(otherTree, aliasedWork, "dir");
    const aliasedCwd = path.join(aliasedWork, "smuggled-review");
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload({ cwd: aliasedCwd }));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("strictly inside");
    const rows = await db.select().from(executionWorkspaces);
    expect(rows.filter((row) => row.cwd === aliasedCwd)).toHaveLength(0);
  });

  it("rejects a prepared cwd spelled inside the work tree of an ancestor alias of the repository root", async () => {
    // The whole repository root is aliased: `<alias>/_work/pr27-final-review`
    // resolves to the same canonical directory as the legitimate prepared cwd,
    // but the spelled path is not the canonical registration identity. The
    // record must carry the canonical path, not an alias of it.
    const aliasRoot = path.join(path.dirname(repoRoot), "repo-alias");
    symlinkSync(repoRoot, aliasRoot, "dir");
    try {
      const aliasedCwd = path.join(aliasRoot, "_work", "pr27-final-review");
      const res = await request(app)
        .post(`/api/projects/${projectId}/execution-workspaces`)
        .send(registerPayload({ cwd: aliasedCwd }));
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("canonical");
      const rows = await db.select().from(executionWorkspaces);
      expect(rows.filter((row) => row.cwd === aliasedCwd)).toHaveLength(0);
    } finally {
      rmSync(aliasRoot, { force: true });
    }
  });

  it("anchors the boundary at the canonical repository root even when the stored primary cwd is an alias", async () => {
    // A primary cwd stored as an alias still resolves to the same canonical
    // repository root, so the boundary cannot be widened by aliasing the
    // primary: a non-canonical spelling under the alias is rejected while the
    // canonical prepared cwd still registers.
    const primaryAlias = path.join(path.dirname(repoRoot), "primary-alias");
    symlinkSync(repoRoot, primaryAlias, "dir");
    try {
      await db.update(projectWorkspaces).set({ cwd: primaryAlias }).where(eq(projectWorkspaces.id, primaryWorkspaceId));
      // A path spelled under the aliased primary is not canonical: rejected.
      const viaAlias = path.join(primaryAlias, "_work", "pr27-final-review");
      const aliasedRes = await request(app)
        .post(`/api/projects/${projectId}/execution-workspaces`)
        .send(registerPayload({ cwd: viaAlias }));
      expect(aliasedRes.status).toBe(422);
      expect(aliasedRes.body.error).toContain("canonical");
      // The canonical prepared cwd still registers through the aliased primary:
      // the canonical root, not the stored spelling, defines the boundary.
      const canonicalRes = await request(app)
        .post(`/api/projects/${projectId}/execution-workspaces`)
        .send(registerPayload({ cwd: preparedCwd }));
      expect(canonicalRes.status).toBe(201);
      expect(canonicalRes.body.cwd).toBe(preparedCwd);
    } finally {
      rmSync(primaryAlias, { force: true });
    }
  });

  it("rejects the canonical primary checkout when its stored nested cwd is aliased", async () => {
    const alias = path.join(repoRoot, "_work", "primary-alias");
    symlinkSync(preparedCwd, alias, "dir");
    await db.update(projectWorkspaces).set({ cwd: alias });
    const res = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("primary checkout");
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
  });

  it("a 500 after the registration commits is an unknown outcome: the same-path retry is idempotent and re-attempts the audit", async () => {
    // The registration transaction commits before the mandatory activity
    // write. If that write fails, the route surfaces 500 with the row already
    // persisted. This pins the contract callers rely on for reconciliation:
    // retry the same payload and get the existing record (200, same id, no
    // duplicate row) while the audit write is re-attempted — never a silent
    // success path that skips mandatory auditing.
    mockLogActivity.mockRejectedValueOnce(new Error("audit injected logging failure"));
    const failed = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(failed.status).toBe(500);
    const rowsAfterFailure = await db.select().from(executionWorkspaces);
    expect(rowsAfterFailure.filter((row) => row.cwd === preparedCwd)).toHaveLength(1);
    const retried = await request(app)
      .post(`/api/projects/${projectId}/execution-workspaces`)
      .send(registerPayload());
    expect(retried.status).toBe(200);
    expect(retried.body.id).toBe(rowsAfterFailure.filter((row) => row.cwd === preparedCwd)[0].id);
    const rowsAfterRetry = await db.select().from(executionWorkspaces);
    expect(rowsAfterRetry.filter((row) => row.cwd === preparedCwd)).toHaveLength(1);
    // The retry's audit write goes through the same mandatory path.
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "execution_workspace.registered_prepared",
        details: expect.objectContaining({ idempotent: true }),
      }),
    );
  });
});
