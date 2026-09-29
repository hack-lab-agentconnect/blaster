/**
 * The agent's texting voice.
 *
 * Outbound agent copy reads like a real person texting, which means three
 * hard rules with no exceptions:
 *
 *   1. Never any capitals. Everything is lowercased, including the first word
 *      and the pronoun i.
 *   2. Never any commas. They are removed, and the gap is closed with a space
 *      so words never join together.
 *   3. Never fully punctually correct. Only `.`, `?`, and `!` survive, at most
 *      one at a time, and sentence structure is left casual: no semicolons,
 *      no colons, no quotes, no parentheses. A double space or a missing
 *      period is fine. That is the point.
 *
 * `formatAgentReply` is the single choke point: every agent reply passes
 * through it before it reaches `sendMessage`, so the voice cannot drift per
 * caller. It is pure and synchronous so it is trivially testable.
 */

const KEPT_PUNCTUATION = new Set([".", "?", "!"]);

function collapsePunctuation(text: string): string {
  let out = "";
  let previousKept: string | null = null;
  for (const char of text) {
    if (KEPT_PUNCTUATION.has(char)) {
      // One terminal mark at a time: "really?!" becomes "really?"
      if (previousKept !== null) continue;
      previousKept = char;
      out += char;
      continue;
    }
    if (char === "," || char === ";" || char === ":") {
      previousKept = null;
      if (char === ",") out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "(" || char === ")") {
      previousKept = null;
      continue;
    }
    previousKept = null;
    out += char;
  }
  return out;
}

/** Enforce the texting voice on one agent reply. */
export function formatAgentReply(raw: string): string {
  return collapsePunctuation(raw.toLowerCase())
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim().replace(/ +([.?!])/g, "$1"))
    .join("\n")
    .trim();
}

/** True when text already obeys the voice, for tests and spot checks. */
export function obeysVoice(text: string): boolean {
  if (text !== text.toLowerCase()) return false;
  if (text.includes(",")) return false;
  if (/[;:"]/.test(text)) return false;
  if (/[.?!]{2,}/.test(text)) return false;
  return true;
}
