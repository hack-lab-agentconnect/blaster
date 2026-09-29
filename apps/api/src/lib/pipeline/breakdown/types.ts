import type { Breakdown, Notification, TwentyRecord } from "@blaster/core";

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
