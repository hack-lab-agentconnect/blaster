// Pre-push gate: the goal has been outlined recently.
//
// A push is only allowed when goal.md carries a fresh outline of the work: a
// timestamp younger than GOAL_MAX_AGE_MINUTES (20 by default), the commit
// message being pushed, the files changed, and a tick-box task list. The point
// is that a push cannot happen without someone stating what the objective is,
// what moved, and what is still owed — the outline is the artifact, not a
// formality.
//
// Run `node scripts/check-goal.mjs --stamp` to refresh the timestamp after the
// outline is edited.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const GOAL = join(root, "goal.md");

const MAX_AGE_MINUTES = Number(process.env.GOAL_MAX_AGE_MINUTES ?? 20);
const MAX_AGE_MS = MAX_AGE_MINUTES * 60_000;

/** The machine-readable header block: `<!-- goal ... -->`. */
const HEADER = /<!--\s*goal\b([\s\S]*?)-->/;

function headerField(body, key) {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(body);
  return match ? match[1].trim() : null;
}

/** Parse the `updated` and `commit` fields from the goal header. */
export function parseGoalHeader(text) {
  const match = HEADER.exec(text);
  if (!match) return null;
  return {
    updated: headerField(match[1], "updated"),
    commit: headerField(match[1], "commit"),
  };
}

/** The non-empty lines under one `## heading`, up to the next heading. */
export function sectionLines(text, heading) {
  const lines = text.split("\n");
  const wanted = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === wanted);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Everything wrong with an outline, as a list of human-readable reasons.
 *
 * Pure over `(text, now)`, so it is unit-tested without touching the real
 * goal.md or the clock.
 */
export function evaluateGoal(text, now, maxAgeMs) {
  const violations = [];
  if (!text || !text.trim()) {
    violations.push("goal.md is empty.");
    return violations;
  }
  const header = parseGoalHeader(text);
  if (!header) {
    violations.push("goal.md needs a `<!-- goal updated: <iso> commit: <message> -->` header.");
  } else {
    if (!header.updated) {
      violations.push("the goal header is missing `updated`.");
    } else {
      const at = Date.parse(header.updated);
      if (Number.isNaN(at)) {
        violations.push(`the goal header's \`updated\` is not a parseable timestamp: "${header.updated}".`);
      } else if (now - at > maxAgeMs) {
        const ageMinutes = Math.floor((now - at) / 60_000);
        violations.push(
          `goal.md is stale: updated ${header.updated} (${ageMinutes} min ago, limit ${maxAgeMs / 60_000}).`,
        );
      }
    }
    if (!header.commit) {
      violations.push("the goal header is missing `commit:` (the message being pushed).");
    }
  }
  if (sectionLines(text, "Files changed").length === 0) {
    violations.push("`## Files changed` must list at least one file.");
  }
  const boxes = sectionLines(text, "Task").filter((line) => /^-\s*\[[ xX]\]/.test(line));
  if (boxes.length === 0) {
    violations.push("`## Task` must contain at least one `- [ ]` checkbox.");
  }
  return violations;
}

/** Rewrite the header's `updated:` to now, in place. */
function stamp() {
  const text = readFileSync(GOAL, "utf8");
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const next = text.replace(/(\bupdated\s*:\s*)[^\n]+/, `$1${iso}`);
  writeFileSync(GOAL, next);
  console.log(`goal.md stamped ${iso}.`);
}

function selfTest() {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = (ms) => new Date(now - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const good = [
    "# Goal",
    "<!-- goal",
    `updated: ${iso(60_000)}`,
    "commit: do the thing",
    "-->",
    "## Files changed",
    "- a.ts",
    "## Task",
    "- [x] a",
    "- [ ] b",
  ].join("\n");
  const cases = [
    { name: "fresh, complete", text: good, expect: true },
    { name: "stale", text: good.replace(/updated:.*/, `updated: ${iso(21 * 60_000)}`), expect: false },
    { name: "no header", text: good.replace(/<!-- goal[\s\S]*?-->/, ""), expect: false },
    { name: "no files", text: good.replace("- a.ts", ""), expect: false },
    { name: "no checkboxes", text: good.replace("- [x] a", "- a").replace("- [ ] b", "- b"), expect: false },
    { name: "no commit", text: good.replace("commit: do the thing", ""), expect: false },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const ok = evaluateGoal(testCase.text, now, MAX_AGE_MS).length === 0;
    if (ok !== testCase.expect) failures += 1;
    console.log(`  self-test ${ok === testCase.expect ? "ok  " : "FAIL"}  ${testCase.name}`);
  }
  if (failures > 0) {
    console.error(`check-goal: self-test failed with ${failures} bad case(s).`);
    process.exit(1);
  }
  console.log("check-goal: self-test OK");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else if (process.argv.includes("--stamp")) {
  stamp();
} else {
  let text;
  try {
    text = readFileSync(GOAL, "utf8");
  } catch {
    console.error("pre-push: FAIL - goal.md is missing. Write the objective, files changed, commit, and a task list.");
    process.exit(1);
  }
  const violations = evaluateGoal(text, Date.now(), MAX_AGE_MS);
  if (violations.length > 0) {
    console.error(`pre-push: FAIL - goal.md is not a current outline (${violations.length} problem(s)):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("\nUpdate goal.md, then run `node scripts/check-goal.mjs --stamp` before pushing.");
    process.exit(1);
  }
  console.log("pre-push: OK - goal.md is a current outline.");
}
