/**
 * Twenty and pipeline data for the breakdown.
 *
 * The breakdown is built by the pure builder in @blaster/core, from rows read
 * from a live Twenty workspace. Keeping the read separate from the build means
 * the breakdown and its notifications can be tested with no workspace and no
 * credentials, and the same builder serves a Convex-backed snapshot later
 * without changing the endpoint.
 */

import {
  TwentyClient,
  buildBreakdown,
  evaluateNotifications,
  notificationStateKey,
  type Breakdown,
  type Notification,
  type TwentyRecord,
} from "@blaster/core";

/** Hard ceiling on rows read per side, so a large workspace cannot hang a request. */
export const ROW_CEILING = 2000;

export interface BreakdownResult {
  breakdown: Breakdown;
  notifications: Notification[];
  /** Identity of the firing set, so a poller can suppress a repeat. */
  stateKey: string;
  source: "twenty";
  truncated: boolean;
}

export interface BreakdownRead {
  leads: TwentyRecord[];
  calls: TwentyRecord[];
  truncated: boolean;
}

export type BreakdownReader = () => Promise<BreakdownRead>;

export async function readBreakdownFrom(reader: BreakdownReader): Promise<BreakdownResult> {
  const { leads, calls, truncated } = await reader();
  const breakdown = buildBreakdown({ leads, calls, truncated });
  const notifications = evaluateNotifications(breakdown);
  return {
    breakdown,
    notifications,
    stateKey: notificationStateKey(notifications),
    source: "twenty",
    truncated,
  };
}

/**
 * Read both sides from Twenty.
 *
 * `listAll` stops at its own page ceiling, so a workspace larger than
 * ROW_CEILING reports itself as partial rather than presenting a floor as a
 * total.
 */
export function twentyReader(client: TwentyClient): BreakdownReader {
  return async () => {
    const [leads, calls] = await Promise.all([
      client.listAll<TwentyRecord>("agencyLeads", { limit: ROW_CEILING }),
      client.listAll<TwentyRecord>("agencyCalls", { limit: ROW_CEILING }),
    ]);
    return {
      leads,
      calls,
      truncated: leads.length >= ROW_CEILING || calls.length >= ROW_CEILING,
    };
  };
}
