/**
 * Selecting guidance for a resolution.
 *
 * Pure function over plain data: given a resolution path and the available
 * entries, return the entry the agent should follow. Highest version wins
 * when several entries serve the same path, so re-ingesting copy never
 * requires touching the selection logic.
 */

import type { GuidanceEntry } from "../types.ts";
import type { ResolutionPath } from "../../../conversation/classification/types.ts";

export function selectGuidance(
  resolution: ResolutionPath,
  entries: readonly GuidanceEntry[],
): GuidanceEntry | null {
  let best: GuidanceEntry | null = null;
  for (const entry of entries) {
    if (entry.path !== resolution) continue;
    if (!best || entry.version > best.version) best = entry;
  }
  return best;
}
