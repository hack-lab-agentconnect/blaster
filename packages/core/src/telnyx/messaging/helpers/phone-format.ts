/**
 * Phone number formatting and validation, shared by the CLI prompt and any
 * surface that displays a number to the operator.
 *
 * Two jobs, done with libphonenumber-js rather than a hand-kept table, because
 * a table is wrong the moment a jurisdiction outside it is reached:
 *
 * - **Validate** whether a string is a real phone number, and normalise it to
 *   the E.164 form Telnyx accepts. An invalid number is reported, not guessed.
 * - **Format** a number for display with the country (and, when known, the
 *   state) abbreviation in parentheses, e.g. `+1 272 447 0148 (US)`. The
 *   state comes from the caller, not the phone library, because a phone number
 *   does not encode its state.
 */

import { parsePhoneNumber, parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

export interface PhoneValidation {
  /** True when the string parses to a plausible phone number in some country. */
  valid: boolean;
  /** The E.164 form when valid, null otherwise. */
  e164: string | null;
  /** The ISO country the number belongs to, when it parsed. */
  country: CountryCode | null;
}

/**
 * Validate a phone number string. The number may arrive in any common form
 * (`+12724470148`, `12724470148`, `272-447-0148`); a number with no country
 * prefix is read against `defaultCountry`, which callers pass so a bare
 * domestic number is not mistaken for foreign.
 */
export function validatePhone(
  input: string,
  defaultCountry: CountryCode = "US",
): PhoneValidation {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return { valid: false, e164: null, country: null };
  try {
    const parsed = parsePhoneNumber(trimmed, defaultCountry);
    if (!parsed || !parsed.isValid()) {
      return { valid: false, e164: null, country: parsed?.country ?? null };
    }
    return { valid: true, e164: parsed.number, country: parsed.country ?? null };
  } catch {
    return { valid: false, e164: null, country: null };
  }
}

/** The country abbreviation for a phone number, or null when it cannot be read. */
export function phoneCountryAbbrev(input: string, defaultCountry: CountryCode = "US"): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  return (
    parsePhoneNumberFromString(trimmed)?.country ??
    parsePhoneNumber(trimmed, defaultCountry)?.country ??
    null
  );
}

export interface PhoneDisplay {
  /** The E.164 form, or the original string when it could not be normalised. */
  number: string;
  /** The country abbreviation, when the number was parsed to one. */
  country: string | null;
  /** The state abbreviation the caller supplies; a phone number does not carry it. */
  state: string | null;
  /** `+1 272 447 0148 (US)` or, with a state, `+1 272 447 0148 (US, CA)`. */
  label: string;
}

/**
 * Render a phone number for display. The country abbreviation is derived from
 * the number through the phone library; the state abbreviation is the caller's
 * knowledge (a prospect's `region`), passed in so the two can be shown together
 * in the parentheses. An unparseable number falls back to its raw string rather
 * than being dropped.
 */
export function formatPhone(
  input: string,
  options: { state?: string | null; defaultCountry?: CountryCode } = {},
): PhoneDisplay {
  const defaultCountry = options.defaultCountry ?? "US";
  const raw = (input ?? "").trim();
  const parsed = parsePhoneNumberFromString(raw) ?? parsePhoneNumber(raw, defaultCountry);
  const number = parsed?.number ?? raw;
  const country = parsed?.country ?? null;
  const state = options.state?.trim() || null;

  const parenthetical: string[] = [];
  if (country) parenthetical.push(country);
  if (state) parenthetical.push(state);
  const suffix = parenthetical.length > 0 ? ` (${parenthetical.join(", ")})` : "";
  return { number, country, state, label: `${number}${suffix}` };
}
