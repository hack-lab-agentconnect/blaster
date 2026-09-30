/**
 * Pipeline breakdown and the notifications derived from it.
 *
 * The breakdown is the same shape the dialer's admin widget drew, but computed
 * here as a pure function so it can be served over HTTP, tested without a
 * workspace, and reused by the notification evaluator.
 *
 * Notifications are the part the dialer never had: it only had in-app toasts
 * and a widget that recomputed on render. Here the breakdown is evaluated
 * server-side against thresholds, so a transition is something that can be
 * delivered once, recorded, and not repeated.
 */

import { selectValue, type TwentyRecord } from "../../../twenty/client/helpers/client.ts";

/** Lead status vocabulary, keyed by the Twenty `SELECT` values. */
export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "NOT_INTERESTED",
  "CALLBACK",
  "CONVERTED",
  "DO_NOT_CONTACT",
] as const;

/** Call outcome vocabulary, keyed by the Twenty `SELECT` values. */
export const CALL_OUTCOMES = ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "NO_ACTION"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface BreakdownSlice {
  label: string;
  value: string;
  count: number;
  /** Share of the total, 0-100, rounded to one decimal. */
  share: number;
}

export interface Breakdown {
  leads: {
    total: number;
    byStatus: BreakdownSlice[];
  };
  calls: {
    total: number;
    answered: number;
    answerRate: number;
    averageDurationSeconds: number;
    byOutcome: BreakdownSlice[];
  };
  conversion: {
    rate: number;
    converted: number;
  };
  /** True when the underlying query had to stop early, so counts are partial. */
  truncated: boolean;
}

const LEAD_LABELS: Record<LeadStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not interested",
  CALLBACK: "Callback",
  CONVERTED: "Converted",
  DO_NOT_CONTACT: "Do not contact",
};

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  COMPLETED: "Completed",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  FAILED: "Failed",
  NO_ACTION: "No action",
};

function slicesFrom(
  records: TwentyRecord[],
  field: string,
  vocabulary: readonly string[],
  labels: Record<string, string>,
): BreakdownSlice[] {
  const counts = new Map<string, number>(vocabulary.map((value) => [value, 0]));
  let classified = 0;

  for (const record of records) {
    const value = selectValue(record[field]) ?? "";
    if (!value) continue;
    classified += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const total = classified;
  return vocabulary.map((value) => {
    const count = counts.get(value) ?? 0;
    return {
      label: labels[value] ?? value,
      value,
      count,
      share: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface BuildBreakdownInput {
  leads: TwentyRecord[];
  calls: TwentyRecord[];
  /** True when either side stopped at the paging ceiling. */
  truncated?: boolean;
}

/**
 * Build the breakdown from raw Twenty rows.
 *
 * Every count is derived from a `SELECT` value read through `selectValue`, so
 * a row written as `{value,label}` and one written as a bare string count the
 * same.
 */
export function buildBreakdown(input: BuildBreakdownInput): Breakdown {
  const { leads, calls } = input;

  const byStatus = slicesFrom(leads, "status", LEAD_STATUSES, LEAD_LABELS);
  const byOutcome = slicesFrom(calls, "outcome", CALL_OUTCOMES, OUTCOME_LABELS);

  const answered = calls.filter((call) => (selectValue(call.outcome) ?? "") === "COMPLETED").length;
  const durations = calls.map((call) => numeric(call.durationSeconds));
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);

  const converted = leads.filter((lead) => (selectValue(lead.status) ?? "") === "CONVERTED").length;
  const classifiedLeads = byStatus.reduce((sum, slice) => sum + slice.count, 0);

  return {
    leads: { total: classifiedLeads, byStatus },
    calls: {
      total: byOutcome.reduce((sum, slice) => sum + slice.count, 0),
      answered,
      answerRate: calls.length > 0 ? Math.round((answered / calls.length) * 1000) / 10 : 0,
      averageDurationSeconds: calls.length > 0 ? Math.round(totalDuration / calls.length) : 0,
      byOutcome,
    },
    conversion: {
      rate: classifiedLeads > 0 ? Math.round((converted / classifiedLeads) * 1000) / 10 : 0,
      converted,
    },
    truncated: input.truncated ?? false,
  };
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationRule {
  id: string;
  severity: NotificationSeverity;
  /** Evaluate the breakdown and return the message, or null when it does not fire. */
  evaluate: (breakdown: Breakdown) => string | null;
}

export const NOTIFICATION_RULES: NotificationRule[] = [
  {
    id: "pipeline-empty",
    severity: "warning",
    evaluate: (breakdown) =>
      breakdown.leads.total === 0
        ? "No leads in the pipeline. Check the Twenty sync before the next send."
        : null,
  },
  {
    id: "answer-rate-low",
    severity: "warning",
    evaluate: (breakdown) =>
      breakdown.calls.total >= 5 && breakdown.calls.answerRate < 20
        ? `Answer rate is ${breakdown.calls.answerRate}%, below the 20% floor. Check the calling hours or the number pool.`
        : null,
  },
  {
    id: "do-not-contact-spike",
    severity: "critical",
    evaluate: (breakdown) => {
      const dnc = breakdown.leads.byStatus.find((slice) => slice.value === "DO_NOT_CONTACT");
      if (!dnc || breakdown.leads.total === 0) return null;
      return dnc.share >= 25
        ? `Do-not-contact is ${dnc.share}% of the pipeline (${dnc.count} of ${breakdown.leads.total}). Pause sends and review targeting.`
        : null;
    },
  },
  {
    id: "counts-truncated",
    severity: "info",
    evaluate: (breakdown) =>
      breakdown.truncated
        ? "Counts are partial: a query hit the paging ceiling, so these numbers are a floor rather than a total."
        : null,
  },
];

export interface Notification {
  id: string;
  severity: NotificationSeverity;
  message: string;
}

/** Every rule that currently fires, most severe first. */
export function evaluateNotifications(breakdown: Breakdown): Notification[] {
  const fired = NOTIFICATION_RULES.flatMap((rule) => {
    const message = rule.evaluate(breakdown);
    return message ? [{ id: rule.id, severity: rule.severity, message }] : [];
  });

  const order: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return fired.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * The identity of everything currently firing.
 *
 * Two evaluations with the same key mean the same set of rules fired, so a
 * caller can suppress a notification it has already delivered instead of
 * repeating it every poll. Any change to the firing set changes the key.
 */
export function notificationStateKey(notifications: Notification[]): string {
  return notifications.map((notification) => notification.id).sort().join(",") || "none";
}
