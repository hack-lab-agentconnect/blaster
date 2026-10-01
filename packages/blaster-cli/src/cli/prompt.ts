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

/**
 * Choose several values at once.
 *
 * Used by the pool wizard to pick the numbers to add in one pass. `required`
 * defaults to true so an empty selection is re-prompted rather than silently
 * creating an empty pool; pass false when "none" is a valid answer.
 */
export async function askMultiSelect(
  message: string,
  options: Array<{ value: string; label: string; hint?: string }>,
  opts: { initialValues?: string[]; required?: boolean } = {},
): Promise<string[] | null> {
  const value = await clack.multiselect({
    message,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
    initialValues: opts.initialValues,
    required: opts.required ?? true,
  });
  if (clack.isCancel(value)) return null;
  return value as string[];
}

export function begin(title: string): void {
  clack.intro(title);
}

export function finish(summary: string): void {
  clack.outro(summary);
}

/** Styled error line for interactive runs; plain console.error stays for pipes. */
export function fail(message: string): void {
  clack.log.error(message);
}

/** Indeterminate wait (the browser round trip); stop it before printing more. */
export function spin(message: string): { stop: (message?: string) => void } {
  const spinner = clack.spinner();
  spinner.start(message);
  return spinner;
}

export function abort(what: string): number {
  clack.cancel(`Cancelled. ${what} left unchanged.`);
  return 1;
}

export function note(summary: string, message: string): void {
  clack.note(message, summary);
}
