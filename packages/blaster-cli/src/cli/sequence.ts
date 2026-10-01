/**
 * `blaster sequence`: build, review, and dry-run a multi-step send.
 *
 * This is the surface an operator actually touches, and it is deliberately
 * honest about how far it goes. The sequencer's *decision* layer is a statechart
 * in `@blaster/core`; its *execution* layer does not exist yet, because there is
 * no Convex cron, so nothing wakes up and sends a step on its own.
 *
 * Rather than paper over that, `run` says so, names the three things that are
 * missing, and then dry-runs the real statechart over the real recipients so an
 * operator can see which step would be owed, when, and to whom. A dry run that
 * agrees with the runner later is worth far more than a green tick over an
 * unwired system.
 *
 * Prompts appear only when a value is missing, the terminal is a TTY, and --json
 * is off, so flags and pipes stay the scriptable path.
 */

import {
  DEFAULT_OPTIONS,
  dryRunEnrollment,
  summarise,
  validateDraft,
  type EligibilityInput,
  type Recipient,
  type SequenceDraft,
  type SequenceStepDraft,
} from "@blaster/core";
import { askText, begin, finish, isInteractive, note } from "./prompt.ts";
import { deleteDraft, findDraft, readDrafts, saveDraft } from "./sequence-store.ts";

export type Json = (value: unknown) => string;

export interface SequenceContext {
  root: string;
  flags: Map<string, string | boolean>;
  /** True when --json is set: prompts off, output as one JSON document. */
  json: boolean;
  /** The caller's serialiser, so output matches every other command. */
  jsonOut: Json;
  now: () => number;
  /** Injected so the plan is testable without the environment. */
  evaluate: (recipient: EligibilityInput) => {
    eligible: boolean;
    reason: string | null;
    detail: string | null;
  };
}

const DRAFT_FILE_LABEL = ".blaster/sequences.json";

const SEQUENCE_USAGE = `Usage: blaster sequence <action> [name]

  new [name]     Build a draft interactively, check it, and record it
  list           What is recorded
  show <name>    The steps, plus a per-recipient plan
  edit <name>    Change the first message
  run <name>     Dry run: says what is not wired up, then shows the plan
  rm <name>      Forget a draft

  validate       Check a JSON draft and print every problem at once
  preview        Dry run a JSON draft against --recipients

Drafts live in ${DRAFT_FILE_LABEL}. They are local working material: a draft
becomes real when the runner picks it up, and the runner does not exist yet, so
\`blaster sequence run\` says so rather than pretending otherwise.

Add --recipients '[{"id":"1","to":"+15551234567","stateCode":"NY"}]' to any
read-only action for a per-recipient compliance plan.`;

/** The three things standing between a recorded draft and a self-running sequence. */
export const RUNNER_GAPS: readonly string[] = [
  "convex/schema.ts rejects the `ambiguous` and `awaiting-human` statuses the machine produces, so its output cannot be persisted yet.",
  "There is no sequenceSendClaims table, so the claim-before-send guard has no uniqueness constraint to collide against.",
  "There is no convex.json, so no cron has ever run and nothing wakes a due enrollment.",
];

export function readRecipients(flags: Map<string, string | boolean>): Recipient[] {
  const raw = flags.get("recipients");
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as Recipient[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** One row per recipient: what the sequence would do, and why not. */
export interface PlanRow {
  to: string | null;
  verdict: "send" | "skip";
  reason: string | null;
  detail: string;
  state: string;
  timeZone: string | null;
  localHour: number | null;
  quiet: boolean;
  approximateZone: boolean;
  nextAllowedAt: number | null;
}

/**
 * The plan for one recipient, from the machine itself.
 *
 * `dryRunEnrollment` is the same function the runner will call, so a plan printed
 * here is the plan the runner would compute. A second implementation in this
 * file would be a second set of bugs and a plan that drifts from the runner.
 */
export function planForRecipient(
  draft: SequenceDraft,
  recipient: Recipient,
  now: number,
  evaluate: SequenceContext["evaluate"],
): PlanRow {
  const run = dryRunEnrollment({
    enrollmentId: recipient.id || "dry-run",
    sequenceId: draft.name,
    steps: draft.steps,
    fromNumber: draft.fromNumber,
    recipient,
    now,
    evaluate,
  });

  // The machine asked to claim only when it would send. Reading that off the
  // effect rather than off the state name keeps the caller honest if a state is
  // ever added or renamed.
  const wouldSend = run.effect.type === "claim";
  const held = run.nextAllowedAt !== null && run.nextAllowedAt > now;

  let detail: string;
  if (run.state === "awaiting_human") {
    detail = "Recipient could not be placed in a time zone, so no legal send time is known.";
  } else if (run.skipReason === "quiet-hours") {
    // Held, not skipped. The step is still owed and goes out when the window
    // opens, so the wording matters: "not sent" would read as a dropped message.
    detail = `Inside quiet hours in ${run.timeZone ?? "an unknown zone"}; held until the window opens.`;
  } else if (run.skipReason) {
    detail = `Not sent (${run.skipReason}).`;
  } else if (run.quiet || held) {
    detail = `Held until the sending window opens in ${run.timeZone ?? "an unknown zone"}.`;
  } else {
    detail = `Step 1 is inside the 08:00-21:00 window in ${run.timeZone ?? "an unknown zone"}.`;
  }

  return {
    to: recipient.to ?? null,
    verdict: wouldSend ? "send" : "skip",
    reason: run.skipReason,
    detail,
    state: run.state,
    timeZone: run.timeZone,
    localHour: run.localHour,
    quiet: run.quiet,
    approximateZone: run.approximateZone,
    nextAllowedAt: run.nextAllowedAt,
  };
}

export function planFor(
  draft: SequenceDraft,
  recipients: Recipient[],
  now: number,
  evaluate: SequenceContext["evaluate"],
): PlanRow[] {
  return recipients.map((recipient) => planForRecipient(draft, recipient, now, evaluate));
}

function printPlan(rows: PlanRow[]): number {
  if (rows.length === 0) {
    console.log("No recipients supplied. Pass --recipients '[{\"id\":\"1\",\"to\":\"+15551234567\"}]'.");
    return 0;
  }
  for (const row of rows) {
    const to = row.to ?? "(no number)";
    const local = row.localHour === null ? "unknown" : `${String(row.localHour).padStart(2, "0")}:00`;
    console.log(`  ${row.verdict.padEnd(4)} ${to.padEnd(16)} ${local.padEnd(8)} ${row.detail}`);
  }
  const sends = rows.filter((row) => row.verdict === "send").length;
  console.log(`\n${sends} of ${rows.length} would be sent now.`);
  return 0;
}

function printSteps(draft: SequenceDraft): void {
  draft.steps.forEach((step: SequenceStepDraft, index: number) => {
    console.log(
      step.isStop
        ? `  ${index + 1}. (stop condition)`
        : `  ${index + 1}. +${step.delayHours}h  ${step.text}`,
    );
  });
  console.log("");
}

async function newDraft(ctx: SequenceContext): Promise<number> {
  const interactive = isInteractive(ctx.json);
  if (interactive) begin("New sequence");

  const nameFlag = ctx.flags.get("name");
  const name =
    typeof nameFlag === "string" && nameFlag
      ? nameFlag
      : interactive
        ? await askText("Sequence name", { placeholder: "Spring outreach" })
        : null;
  if (!name) {
    if (interactive) finish("Nothing recorded.");
    else console.error("blaster sequence new: pass --name, or run it in a terminal to be prompted");
    return 1;
  }

  const fromFlag = ctx.flags.get("from");
  const from =
    typeof fromFlag === "string" && fromFlag
      ? fromFlag
      : interactive
        ? await askText("Sending number (E.164)", { placeholder: "+353871234567" })
        : null;
  if (!from) {
    console.error("blaster sequence new: a sending number is required");
    return 1;
  }

  const steps: SequenceStepDraft[] = [];
  if (interactive) {
    for (;;) {
      const text = await askText(
        steps.length === 0 ? "First message" : `Message ${steps.length + 1}`,
        { placeholder: "leave empty to finish and add a stop" },
      );
      if (text === null) return 1;
      if (text === "") {
        const confirm = await askText("End the sequence after that? (yes/no)", {
          defaultValue: "yes",
        });
        if (confirm === null) return 1;
        if (confirm === "yes") steps.push({ text: "", delayHours: 0, isStop: true });
        break;
      }
      const delay = await askText("Hours to wait before this message", {
        defaultValue: steps.length === 0 ? "0" : "48",
      });
      if (delay === null) return 1;
      const delayHours = Number(delay || "0");
      if (!Number.isFinite(delayHours) || delayHours < 0) {
        console.error("The delay must be zero or more hours.");
        return 1;
      }
      steps.push({ text, delayHours, isStop: false });
    }
  }

  const draft: SequenceDraft = { name, fromNumber: from, options: { ...DEFAULT_OPTIONS }, steps };
  const problems = validateDraft(draft);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem.field}: ${problem.problem}`);
    return 1;
  }

  const created = saveDraft(ctx.root, draft, new Date(ctx.now()).toISOString());
  const summary = summarise(draft);
  if (ctx.json) {
    console.log(ctx.jsonOut({ recorded: true, created, draft, summary }));
  } else if (interactive) {
    finish(
      `${created ? "Recorded" : "Updated"} "${name}": ${summary.sendingSteps} message(s) across ${summary.spanHours}h.`,
    );
  } else {
    console.log(`${created ? "Recorded" : "Updated"} "${name}" in ${DRAFT_FILE_LABEL}.`);
  }
  return 0;
}

async function listDrafts(ctx: SequenceContext): Promise<number> {
  const drafts = readDrafts(ctx.root);
  if (ctx.json) {
    console.log(ctx.jsonOut({ drafts: drafts.map((entry) => entry.draft) }));
    return 0;
  }
  if (drafts.length === 0) {
    console.log('No sequences recorded yet. Create one with `blaster sequence new`.');
    return 0;
  }
  for (const entry of drafts) {
    const summary = summarise(entry.draft);
    console.log(
      `  ${entry.draft.name.padEnd(24)} ${String(summary.sendingSteps).padStart(2)} message(s)  ${entry.draft.fromNumber}`,
    );
  }
  return 0;
}

async function showDraft(ctx: SequenceContext, name: string | undefined): Promise<number> {
  if (!name) {
    console.error("blaster sequence show: name the sequence");
    return 1;
  }
  const entry = findDraft(ctx.root, name);
  if (!entry) {
    console.error(`No sequence named "${name}". \`blaster sequence list\` shows what exists.`);
    return 1;
  }
  const draft = entry.draft;
  const summary = summarise(draft);
  const rows = planFor(draft, readRecipients(ctx.flags), ctx.now(), ctx.evaluate);

  if (ctx.json) {
    console.log(ctx.jsonOut({ draft, summary, updatedAt: entry.updatedAt, plan: rows }));
    return 0;
  }
  console.log(`${draft.name}  (${draft.fromNumber})`);
  console.log(
    `  ${summary.sendingSteps} message(s) over ${summary.spanHours}h, first at +${summary.firstStepHours}h.`,
  );
  if (summary.stopStep) console.log("  Ends on a stop condition.");
  printSteps(draft);
  return printPlan(rows);
}

async function runDraft(ctx: SequenceContext, name: string | undefined): Promise<number> {
  if (!name) {
    console.error("blaster sequence run: name the sequence");
    return 1;
  }
  const entry = findDraft(ctx.root, name);
  if (!entry) {
    console.error(`No sequence named "${name}". \`blaster sequence list\` shows what exists.`);
    return 1;
  }
  const draft = entry.draft;
  const now = ctx.now();
  const recipients = readRecipients(ctx.flags);
  const rows = planFor(draft, recipients, now, ctx.evaluate);
  const interactive = isInteractive(ctx.json);

  if (ctx.json) {
    console.log(ctx.jsonOut({ sent: false, dryRun: true, gaps: RUNNER_GAPS, plan: rows }));
    return 0;
  }

  // Said before anything else, so it cannot be read past.
  console.log("The runner is not wired up. Nothing will be sent by this command.\n");
  console.log("Still missing:");
  for (const gap of RUNNER_GAPS) console.log(`  - ${gap}`);
  console.log("");

  if (interactive) {
    begin(`Dry run: ${draft.name}`);
    note("Nothing was sent", "The runner does not exist yet; this is what it would do.");
  }
  console.log("What the statechart does, one tick from now:");
  for (const row of rows) {
    console.log(
      `  ${(row.to ?? "(no number)").padEnd(16)} -> ${row.state.padEnd(14)} ${row.reason ?? row.detail}`,
    );
  }
  console.log("");
  const code = printPlan(rows);
  if (interactive) finish("Dry run complete. Nothing sent.");
  return code;
}

async function editDraft(ctx: SequenceContext, name: string | undefined): Promise<number> {
  if (!name) {
    console.error("blaster sequence edit: name the sequence");
    return 1;
  }
  const entry = findDraft(ctx.root, name);
  if (!entry) {
    console.error(`No sequence named "${name}". \`blaster sequence list\` shows what exists.`);
    return 1;
  }
  if (!isInteractive(ctx.json)) {
    console.error(
      "blaster sequence edit is interactive. Non-interactively, use `blaster sequence new --name ... --from ...` with a full draft, or edit the file.",
    );
    return 1;
  }
  begin(`Edit ${entry.draft.name}`);
  const flag = ctx.flags.get("message");
  const message =
    typeof flag === "string" && flag ? flag : await askText("New first message");
  if (message === null || message === "") {
    finish("Unchanged.");
    return 1;
  }
  const updated: SequenceDraft = {
    ...entry.draft,
    steps: [{ text: message, delayHours: 0, isStop: false }, ...entry.draft.steps.slice(1)],
  };
  const problems = validateDraft(updated);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem.field}: ${problem.problem}`);
    return 1;
  }
  saveDraft(ctx.root, updated, new Date(ctx.now()).toISOString());
  finish(`Updated "${updated.name}".`);
  return 0;
}

async function removeDraft(ctx: SequenceContext, name: string | undefined): Promise<number> {
  if (!name) {
    console.error("blaster sequence rm: name the sequence");
    return 1;
  }
  if (!deleteDraft(ctx.root, name)) {
    console.error(`No sequence named "${name}".`);
    return 1;
  }
  console.log(`Removed "${name}".`);
  return 0;
}


export async function sequenceMain(
  ctx: SequenceContext,
  action: string | undefined,
  name: string | undefined,
): Promise<number> {
  switch (action) {
    case "new":
    case "create":
      return await newDraft(ctx);
    case "list":
    case "ls":
      return await listDrafts(ctx);
    case "show":
      return await showDraft(ctx, name);
    case "edit":
      return await editDraft(ctx, name);
    case "run":
    case "dry-run":
      return await runDraft(ctx, name);
    case "rm":
    case "delete":
      return await removeDraft(ctx, name);
    case "help":
    case undefined:
      console.log(SEQUENCE_USAGE);
      return 0;
    default:
      console.error(`blaster sequence: unknown action "${action}"\n${SEQUENCE_USAGE}`);
      return 1;
  }
}
