import { and, asc, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/**
 * Version of the single-retry-successor contract, advertised on detailed
 * `GET /api/health` as `features.failedRunRetrySuccessorReplay`.
 *
 * 1: a run has at most one `retryOfRunId` successor. Exact Board failed-run
 * admission (`failedRunId` + `retry_failed_run`) locks the issue and the
 * failed run, then replays ANY existing successor of that run for the same
 * company and agent (native `scheduled_retry`, queued, running or terminal)
 * without a new run or wake; another agent's successor is a conflict. The
 * automatic schedulers take the same row locks and adopt, or do not add
 * beside, an existing successor.
 */
export const FAILED_RUN_RETRY_SUCCESSOR_REPLAY_VERSION = 1 as const;

/** The one retry successor of a run, read under the caller's row locks. */
export async function findRetrySuccessor(tx: Db, companyId: string, runId: string) {
  const [successor] = await tx
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(1);
  return successor ?? null;
}
