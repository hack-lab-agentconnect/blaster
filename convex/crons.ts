import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

/**
 * Scheduled work.
 *
 * One job, and it is the one that makes the sequencer a sequencer: without it
 * nothing ever wakes a due enrollment, so `runDueEnrollments` — which exists and
 * is correct — is read by nobody. This file is why the runner runs.
 *
 * The target is `internal.*`, never `api.*` (rule R8): a scheduled call must
 * reach a function that is not client-reachable, so a later change to a public
 * function's exposure cannot silently widen what the backend invokes.
 *
 * A minute is the tick. The runner is deliberately sequential and bounded per
 * tick (see `runDueEnrollments`), so the cadence and the batch size together are
 * what keep a backlog from becoming a burst against one Telnyx account. Moving
 * this interval without reading that action is how the two disagree.
 */
const crons = cronJobs();

crons.interval(
  "sequence runner",
  { minutes: 1 },
  internal.sequence.actions.runDueEnrollments,
  // Bounded work per tick. The due queue is drained oldest-first and the tick is
  // a minute, so a cap of 25 keeps a normal backlog moving while never fanning
  // out wide enough to turn a rate-limit rejection into an outage.
  { limit: 25 },
);

export default crons;
