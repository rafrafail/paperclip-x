import { z } from "zod";
import {
  WORKSPACE_OVERVIEW_DEFAULT_LIMIT,
  WORKSPACE_OVERVIEW_MAX_LIMIT,
} from "../constants.js";

export const executionWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

export const executionWorkspaceDeliveryStateSchema = z.enum([
  "merged_via_pr",
  "merged_by_ancestry",
  "unmerged",
  "unknown",
]);

const workspaceOverviewStatusFilterSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const statuses = rawValues.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    return entry.split(",").map((part) => part.trim()).filter(Boolean);
  });
  return statuses.length > 0 ? statuses : undefined;
}, z.array(executionWorkspaceStatusSchema).optional());

export const workspaceOverviewQuerySchema = z.object({
  projectId: z.string().guid().optional(),
  status: workspaceOverviewStatusFilterSchema,
  limit: z.coerce.number().int().min(1).max(WORKSPACE_OVERVIEW_MAX_LIMIT).optional().default(WORKSPACE_OVERVIEW_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();

export const executionWorkspaceConfigSchema = z.object({
  environmentId: z.string().guid().optional().nullable(),
  provisionCommand: z.string().optional().nullable(),
  runtimeProvisionCommand: z.string().optional().nullable(),
  teardownCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.string(), z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

export const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
}).strict();

export const executionWorkspaceCloseReadinessStateSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "blocked",
]);

export const executionWorkspaceCloseActionKindSchema = z.enum([
  "archive_record",
  "stop_runtime_services",
  "cleanup_command",
  "teardown_command",
  "git_worktree_remove",
  "git_branch_delete",
  "remove_local_directory",
]);

export const executionWorkspaceCloseActionSchema = z.object({
  kind: executionWorkspaceCloseActionKindSchema,
  label: z.string(),
  description: z.string(),
  command: z.string().nullable(),
}).strict();

export const executionWorkspaceCloseLinkedIssueSchema = z.object({
  id: z.string().guid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  isTerminal: z.boolean(),
}).strict();

export const executionWorkspaceCloseGitReadinessSchema = z.object({
  repoRoot: z.string().nullable(),
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  hasDirtyTrackedFiles: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
  isMergedIntoBase: z.boolean().nullable(),
  createdByRuntime: z.boolean(),
}).strict();

export const workspaceRuntimeServiceSchema = z.object({
  id: z.string(),
  companyId: z.string().guid(),
  projectId: z.string().guid().nullable(),
  projectWorkspaceId: z.string().guid().nullable(),
  executionWorkspaceId: z.string().guid().nullable(),
  issueId: z.string().guid().nullable(),
  scopeType: z.enum(["project_workspace", "execution_workspace", "run", "agent"]),
  scopeId: z.string().nullable(),
  serviceName: z.string(),
  status: z.enum(["provisioning", "starting", "running", "stopped", "failed"]),
  lifecycle: z.enum(["shared", "ephemeral"]),
  reuseKey: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  provider: z.enum(["local_process", "adapter_managed"]),
  providerRef: z.string().nullable(),
  ownerAgentId: z.string().guid().nullable(),
  startedByRunId: z.string().guid().nullable(),
  lastUsedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  stopPolicy: z.record(z.string(), z.unknown()).nullable(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  configIndex: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export const executionWorkspaceCloseReadinessSchema = z.object({
  workspaceId: z.string().guid(),
  deliveryState: executionWorkspaceDeliveryStateSchema,
  state: executionWorkspaceCloseReadinessStateSchema,
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  linkedIssues: z.array(executionWorkspaceCloseLinkedIssueSchema),
  plannedActions: z.array(executionWorkspaceCloseActionSchema),
  isDestructiveCloseAllowed: z.boolean(),
  isSharedWorkspace: z.boolean(),
  isProjectPrimaryWorkspace: z.boolean(),
  git: executionWorkspaceCloseGitReadinessSchema.nullable(),
  runtimeServices: z.array(workspaceRuntimeServiceSchema),
}).strict();

export const updateExecutionWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  cwd: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  baseRef: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  providerRef: z.string().optional().nullable(),
  status: executionWorkspaceStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
  config: executionWorkspaceConfigSchema.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const branchReconcileReasonSchema = z.string().trim().min(1);

export const reconcileExecutionWorkspaceBranchSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("forward"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
  z.object({
    mode: z.literal("override"),
    reason: branchReconcileReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal("quarantine_restore"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
]);

/**
 * Register an already-prepared, detached execution workspace on disk as an
 * execution workspace record. This exists for prepared independent review
 * checkouts (and equivalent operator-prepared pristine worktrees): the record
 * must describe the exact on-disk identity — an absolute normalized path, the
 * exact git object id it is detached at, and the project's repository URL —
 * and it never carries a branch, a source issue, or host-executed commands.
 */
const preparedExecutionWorkspaceCwdSchema = z.string().min(1).max(4096).refine((value) => {
  if (value !== value.trim() || value.includes("\x00")) return false;
  if (!value.startsWith("/")) return false;
  const segments = value.split("/").slice(1);
  return segments.length > 0
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "cwd must be a normalized absolute path without '.', '..' or empty segments");

const preparedExecutionWorkspaceBaseRefSchema = z.string().regex(
  /^[0-9a-f]{40}$/,
  "baseRef must be an exact 40-character lowercase git object id",
);

const preparedExecutionWorkspaceRepoUrlSchema = z.string().min(1).max(2048).refine((value) => {
  if (value !== value.trim()) return false;
  return ![...value].some((ch) => ch.charCodeAt(0) < 32 || ch === " ");
}, "repoUrl must be a trimmed repository URL without whitespace or control characters");

export const registerPreparedExecutionWorkspaceSchema = z.object({
  cwd: preparedExecutionWorkspaceCwdSchema,
  repoUrl: preparedExecutionWorkspaceRepoUrlSchema,
  baseRef: preparedExecutionWorkspaceBaseRefSchema,
  status: z.enum(["idle", "in_review"]).optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();

export type RegisterPreparedExecutionWorkspace = z.infer<typeof registerPreparedExecutionWorkspaceSchema>;

export type UpdateExecutionWorkspace = z.infer<typeof updateExecutionWorkspaceSchema>;
export type ReconcileExecutionWorkspaceBranch = z.infer<typeof reconcileExecutionWorkspaceBranchSchema>;
export type WorkspaceOverviewQuery = z.infer<typeof workspaceOverviewQuerySchema>;
