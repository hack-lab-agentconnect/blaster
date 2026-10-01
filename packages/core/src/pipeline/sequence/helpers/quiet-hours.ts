/**
 * TCPA quiet hours.
 *
 * Marketing texts may not be sent before 8:00am or after 9:00pm **in the
 * recipient's local time** (47 CFR 64.1200(c)(1)). Three properties of that
 * sentence are the whole reason this is a module:
 *
 *   - *Recipient's* local time. Not the sender's, not the server's. A 9:30pm
 *     Eastern send is already past quiet hours for an East-Coast recipient while
 *     it is only 6:30pm on the West Coast.
 *   - It is a wall-clock window, not an offset. A step whose delay lands at 3am
 *     is a violation no matter how the arithmetic came out.
 *   - Consent is not currently a defence. Since November 2024 a wave of class
 *     actions has alleged quiet-hours violations *even where the recipient
 *     consented*, and the industry's FCC petition arguing that written consent
 *     forecloses the claim is still unresolved. So the window is enforced
 *     unconditionally rather than being something a flag can switch off.
 *
 * The zone comes from the recipient's area code, which `derivePhoneState`
 * already resolves to a US state. Several states sit in more than one zone, and
 * a single zone per state is an approximation; the table below is documented as
 * such and every multi-zone state resolves to the zone covering the largest
 * share of its numbers. Where the answer would be uncertain near an edge the
 * caller is told so it can bias conservative.
 *
 * Not legal advice. Verify against the regulation before relying on a number.
 */

import { normaliseCountry } from "../../../telnyx/messaging/helpers/profile.ts";

/** The sending window, in the recipient's local time. */
export const QUIET_HOURS_START_HOUR = 8;
export const QUIET_HOURS_END_HOUR = 21;

export interface QuietHoursWindow {
  /** IANA zone name, or null when the number could not be placed. */
  timeZone: string | null;
  /** True when `at` falls outside the allowed window in that zone. */
  quiet: boolean;
  /** The recipient's local hour, 0-23, or null when the zone is unknown. */
  localHour: number | null;
  /**
   * True when the zone came from a state that spans more than one, so a send
   * near an edge could be legal or not depending on where in the state the
   * number actually is. Callers should treat these as "assume quiet".
   */
  approximate: boolean;
}

/**
 * US state and territory code to IANA zone.
 *
 * Keyed on what `derivePhoneState` returns. The two states marked approximate
 * genuinely straddle zones (Florida runs Eastern and Central; Tennessee and
 * Indiana likewise), and the zones chosen are the ones covering most of their
 * numbers.
 */
const STATE_TIME_ZONES: Record<string, { zone: string; approximate?: boolean }> = {
  // Eastern
  CT: { zone: "America/New_York" },
  DC: { zone: "America/New_York" },
  DE: { zone: "America/New_York" },
  GA: { zone: "America/New_York" },
  MA: { zone: "America/New_York" },
  MD: { zone: "America/New_York" },
  ME: { zone: "America/New_York" },
  MI: { zone: "America/Detroit" },
  NH: { zone: "America/New_York" },
  NJ: { zone: "America/New_York" },
  NY: { zone: "America/New_York" },
  NC: { zone: "America/New_York" },
  OH: { zone: "America/New_York" },
  PA: { zone: "America/New_York" },
  RI: { zone: "America/New_York" },
  SC: { zone: "America/New_York" },
  VA: { zone: "America/New_York" },
  VT: { zone: "America/New_York" },
  WV: { zone: "America/New_York" },
  // Florida and Tennessee straddle Eastern and Central.
  FL: { zone: "America/New_York", approximate: true },
  TN: { zone: "America/Chicago", approximate: true },
  IN: { zone: "America/Indiana/Indianapolis", approximate: true },
  // Central
  AR: { zone: "America/Chicago" },
  IA: { zone: "America/Chicago" },
  IL: { zone: "America/Chicago" },
  KS: { zone: "America/Chicago" },
  KY: { zone: "America/New_York", approximate: true },
  LA: { zone: "America/Chicago" },
  MN: { zone: "America/Chicago" },
  MO: { zone: "America/Chicago" },
  MS: { zone: "America/Chicago" },
  NE: { zone: "America/Chicago", approximate: true },
  ND: { zone: "America/Chicago", approximate: true },
  OK: { zone: "America/Chicago" },
  SD: { zone: "America/Chicago", approximate: true },
  TX: { zone: "America/Chicago", approximate: true },
  WI: { zone: "America/Chicago" },
  // Mountain
  AZ: { zone: "America/Phoenix" },
  CO: { zone: "America/Denver" },
  ID: { zone: "America/Boise", approximate: true },
  MT: { zone: "America/Denver" },
  NM: { zone: "America/Denver" },
  UT: { zone: "America/Denver" },
  WY: { zone: "America/Denver" },
  // Pacific
  AK: { zone: "America/Anchorage" },
  CA: { zone: "America/Los_Angeles" },
  HI: { zone: "Pacific/Honolulu" },
  NV: { zone: "America/Los_Angeles" },
  OR: { zone: "America/Los_Angeles" },
  WA: { zone: "America/Los_Angeles" },
  // Territories
  PR: { zone: "America/Puerto_Rico" },
  VI: { zone: "America/St_Thomas" },
};

const HOUR_MS = 3_600_000;

/**
 * The IANA zone for a US state or territory code, or null when unknown.
 *
 * Unknown is not an error and is deliberately not a pass. A caller that cannot
 * place a number should decide its own policy, and `quietHoursWindow` reports
 * `quiet: true` for it so the conservative reading is the one that happens if
 * nobody decides.
 */
export function timeZoneForState(stateCode: string | null | undefined): {
  timeZone: string | null;
  approximate: boolean;
} {
  if (!stateCode) return { timeZone: null, approximate: false };
  const entry = STATE_TIME_ZONES[stateCode.toUpperCase()];
  if (!entry) return { timeZone: null, approximate: false };
  return { timeZone: entry.zone, approximate: entry.approximate ?? false };
}

/**
 * The hour of day in `zone` at the instant `at`, or null when the zone cannot
 * be read.
 *
 * `Intl.DateTimeFormat` with an explicit zone is used rather than a fixed
 * offset, so daylight saving is handled. An unknown zone is a null rather than
 * UTC, because guessing UTC would put a US recipient an hour out for half the
 * year and quietly make a legal send look illegal.
 */
export function localHourIn(timeZone: string | null, at: number): number | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const hour = parts.find((part) => part.type === "hour")?.value;
    const parsed = hour === undefined ? Number.NaN : Number(hour);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    // An unknown IANA name throws rather than returning null.
    return null;
  }
}

/**
 * Is `at` inside the sending window for a recipient in `timeZone`?
 *
 * Boundaries are inclusive at 8:00am and exclusive at 9:00pm: the window is
 * [08:00, 21:00). An unreadable zone is reported quiet, so the answer that
 * happens by default is the one that does not send.
 */
export function quietHoursWindow(
  timeZone: string | null,
  at: number,
  approximate = false,
): QuietHoursWindow {
  const localHour = localHourIn(timeZone, at);
  if (localHour === null) {
    return { timeZone: null, quiet: true, localHour: null, approximate: true };
  }
  const quiet = localHour < QUIET_HOURS_START_HOUR || localHour >= QUIET_HOURS_END_HOUR;
  return { timeZone, quiet, localHour, approximate };
}

/** Convenience for a number that could not be placed. Always quiet. */
export function unplaceableWindow(): QuietHoursWindow {
  return { timeZone: null, quiet: true, localHour: null, approximate: true };
}

/**
 * The first instant at or after `from` that is inside the window, or null when
 * the answer cannot be computed.
 *
 * A due step that lands in quiet hours is pushed here rather than dropped, so a
 * sequence enrolled at 11pm still completes instead of silently losing its
 * first message. When the zone is unknown the answer is null, which the caller
 * reads as "cannot schedule" and is a decision for a human rather than a
 * timestamp this function is willing to invent.
 */
export function nextAllowedSendAt(
  timeZone: string | null,
  from: number,
  approximate = false,
): number | null {
  const current = quietHoursWindow(timeZone, from, approximate);
  if (current.localHour === null) return null;
  if (!current.quiet) return from;

  // Walk forward in whole hours until the window is open. One day's worth is
  // the bound: a 24-step walk from any local hour is certain to pass through
  // 08:00-21:00, and it stops at the first one rather than skipping a day.
  for (let step = 1; step <= 24; step += 1) {
    const candidate = from + step * HOUR_MS;
    const window = quietHoursWindow(timeZone, candidate, approximate);
    if (window.localHour === null) return null;
    if (!window.quiet) return candidate;
  }
  return null;
}

/**
 * The zone for a recipient, from its number's country and US state.
 *
 * `normaliseCountry` gives the ISO country the number belongs to, so a number
 * that is not US cannot be placed by this table and is reported unplaceable
 * rather than being forced into a US zone.
 */
export function timeZoneForNumber(
  to: string | null | undefined,
  stateCode: string | null | undefined,
): { timeZone: string | null; approximate: boolean } {
  if (!to || !to.trim()) return { timeZone: null, approximate: false };
  const country = normaliseCountry(to);
  // The state table is NANP-only. A Canadian number also comes back as a
  // territory code from the parser, so the check is against the country the
  // number actually belongs to rather than the +1 plan.
  if (country && country !== "US") return { timeZone: null, approximate: false };
  return timeZoneForState(stateCode);
}
