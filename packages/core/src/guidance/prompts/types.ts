/**
 * Guidance prompt entries.
 *
 * A guidance entry is a named, versioned piece of reply guidance the agent
 * may use for one resolution path. Resolutions reference guidance by id, so
 * the "what do we say when they object" copy lives here as data instead of
 * as hardcoded strings scattered through callers. Ingesting a new follow-up
 * backlog means adding entries, never editing logic.
 *
 * Seed entries ship as versioned constants (GUIDANCE_SEED_VERSION). A Convex
 * `guidanceEntries` table can supersede them later without changing callers:
 * both shapes satisfy `GuidanceEntry`.
 */

import type { ResolutionPath } from "../../conversation/classification/types.ts";

export interface GuidanceEntry {
  /** Stable id, e.g. "objection.price.v1". Resolutions reference this. */
  id: string;
  /** Incremented whenever the text changes, so audits can pin a version. */
  version: number;
  /** The resolution path this entry serves. */
  path: ResolutionPath;
  /** Reply guidance in the texting voice: lowercase, no commas. */
  text: string;
}

export const GUIDANCE_SEED_VERSION = 1;

export const GUIDANCE_SEED: readonly GuidanceEntry[] = [
  {
    id: "answer.direct.v1",
    version: 1,
    path: "answer",
    text: "answer their exact question in one short text. no pitch. end with one simple question that keeps it moving",
  },
  {
    id: "qualify.next.v1",
    version: 1,
    path: "qualify",
    text: "they are warm. ask the one qualifying question that decides if this is worth a call. keep it casual and short",
  },
  {
    id: "objection.price.v1",
    version: 1,
    path: "handle_objection",
    text: "do not defend the price. ask what they were hoping it would be then bridge to what that gets them",
  },
  {
    id: "objection.trust.v1",
    version: 1,
    path: "handle_objection",
    text: "they do not trust us yet. offer proof not promises. one local example or one simple guarantee",
  },
  {
    id: "rebook.later.v1",
    version: 1,
    path: "rebook",
    text: "agree to their timing without guilt. propose one specific later time so it stays real",
  },
  {
    id: "escalate.human.v1",
    version: 1,
    path: "escalate",
    text: "do not reply. hand the full thread to a human with the classification reason attached",
  },
  {
    id: "close.wrap.v1",
    version: 1,
    path: "close",
    text: "wrap it up clean in one text. thank them. leave the door open with no pressure",
  },
  {
    id: "suppress.optout.v1",
    version: 1,
    path: "suppress",
    text: "send nothing. ever. mark suppressed and stop all messaging on this thread",
  },
] as const;
