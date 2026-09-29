/**
 * Interactive operator prompts over @clack/prompts.
 *
 * Flags and stdin/JSON stay the scriptable path: prompting only happens when
 * a required value is missing, stdout is a TTY, and `--json` is off. Anything
 * else keeps the old behaviour (an error naming the missing value), so pipes
 * and automation never hang waiting for input that will never come.
 *
 * A cancelled prompt (Ctrl+C) is a clean exit code 1 with the partial state
 * named, never a half-executed command.
 */

import * as clack from "@clack/prompts";

export function isInteractive(json: boolean): boolean {
  if (json) return false;
  if (process.env.CI === "true") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** False when the operator cancelled; the caller should stop, not proceed. */
export function cancelled<T>(value: T | symbol): value is symbol {
  return clack.isCancel(value);
}

export async function askText(
  message: string,
  opts: { placeholder?: string; defaultValue?: string } = {},
): Promise<string | null> {
  const value = await clack.text({
    message,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    validate: (input) => (!input || input.trim().length === 0 ? "A value is required." : undefined),
  });
  if (clack.isCancel(value)) return null;
  return value.trim();
}

export async function askSelect(
  message: string,
  options: Array<{ value: string; label: string; hint?: string }>,
): Promise<string | null> {
  const value = await clack.select({
    message,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
  });
  if (clack.isCancel(value)) return null;
  return value;
}

export async function askConfirm(message: string, initial = false): Promise<boolean | null> {
  const value = await clack.confirm({ message, initialValue: initial });
  if (clack.isCancel(value)) return null;
  return value;
}

export function begin(title: string): void {
  clack.intro(title);
}

export function finish(summary: string): void {
  clack.outro(summary);
}

export function abort(what: string): number {
  clack.cancel(`Cancelled. ${what} left unchanged.`);
  return 1;
}

export function note(summary: string, message: string): void {
  clack.note(message, summary);
}
