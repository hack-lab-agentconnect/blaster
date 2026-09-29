/**
 * Reading the pipeline breakdown, and the bound on how much of it we read.
 *
 * The breakdown answers one question — how many leads and calls, and which
 * notifications does that fire — so it reads `agencyLeads` and `agencyCalls`
 * and stops. The ceiling exists because a workspace with a large history would
 * otherwise make one dashboard request walk every record, and because a count
 * we know is incomplete must say so: the notification set then reports a floor
 * rather than a total, and a reader is never told "there is nothing more".
 *
 * The reader is a function so this stays testable without Twenty, and so the
 * route can be exercised with a fake that returns two rows instead of a real
 * workspace.
 */

import {
  buildBreakdown,
  evaluateNotifications,
  notificationStateKey,
  type TwentyClient,
  type TwentyRecord,
} from "@blaster/core";
import type { BreakdownReader, BreakdownResult } from "./types.ts";

/**
 * Rows read per object, per request.
 *
 * 200 matches the largest page the CLI and the MCP tools will ask for, so a
 * breakdown can never be slower than a full page the user would otherwise wait
 * for anyway. Above this the counts stop being a total and start being a floor,
 * which the caller is told rather than left to infer.
 */
export const ROW_CEILING = 200;

const OBJECTS = { leads: "agencyLeads", calls: "agencyCalls" } as const;

/** Read both objects up to the ceiling, and report whether either hit it. */
export function twentyReader(client: TwentyClient): BreakdownReader {
  return async () => {
    const [leads, calls] = await Promise.all([
      client.listAll<TwentyRecord>(OBJECTS.leads, { limit: ROW_CEILING }),
      client.listAll<TwentyRecord>(OBJECTS.calls, { limit: ROW_CEILING }),
    ]);
    // Either side reaching the ceiling means the counts are a floor, and the
    // breakdown is built with that flag so it says so in the notification set.
    const truncated = leads.length >= ROW_CEILING || calls.length >= ROW_CEILING;
    return { leads, calls, truncated };
  };
}

/** Turn a read into the route's response shape. */
export async function readBreakdownFrom(reader: BreakdownReader): Promise<BreakdownResult> {
  const { leads, calls, truncated } = await reader();
  const breakdown = buildBreakdown({ leads, calls, truncated });
  const notifications = evaluateNotifications(breakdown);
  return {
    breakdown,
    notifications,
    // The firing set's identity, so a poller that sees it twice knows not to
    // announce the same counts again.
    stateKey: notificationStateKey(notifications),
    source: "twenty",
    truncated,
  };
}
