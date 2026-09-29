/**
 * Country resolution and messaging profile selection.
 *
 * A Telnyx messaging profile is a registration, not a routing preference. The
 * profile has to match the jurisdiction of the recipient: US recipients need a
 * 10DLC brand and campaign, while IE and GB recipients cannot use 10DLC at all
 * and need a profile carrying an alphanumeric sender. Sending an Irish number
 * from a US profile is rejected by the carrier after Telnyx has already accepted
 * the message, so the profile is chosen from the recipient's country before the
 * send rather than from whatever the sending number happens to carry.
 *
 * Country detection goes through libphonenumber-js rather than a hand-kept
 * table of dial codes. A table is wrong the moment a jurisdiction outside it
 * receives a message, and a table cannot tell an invalid number from an
 * unlisted country. The library parses the number properly, so `+353...`
 * resolves to IE and a malformed number resolves to nothing, which are
 * different situations with different correct answers.
 *
 * Which countries have a profile is configuration, not code. `countryProfiles`
 * accepts either a mapping or the compact `US=<id>,IE=<id>` form, so adding a
 * country is a configuration change and never a code change.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const PROFILES = {
  default: "TELNYX_MESSAGING_PROFILE_ID",
  us: "TELNYX_MESSAGING_PROFILE_US",
  ie: "TELNYX_MESSAGING_PROFILE_IE",
  /** The general mechanism: `US=<id>,IE=<id>,...`. */
  map: "TELNYX_MESSAGING_PROFILES",
} as const;

export type ProfileSlot = keyof typeof PROFILES;

export type SelectionReason =
  | "bound-to-number"
  | "recipient-country"
  | "default-fallback"
  | "no-profile-configured";

export interface ProfileResolution {
  /** Where the chosen profile came from: an explicit country, or the default. */
  slot: ProfileSlot | "country-map" | null;
  /** The profile id itself, or null when nothing is configured. */
  profileId: string | null;
  reason: SelectionReason;
  /** The country the recipient resolved to, when it resolved at all. */
  country: string | null;
  /** Set when the recipient country has no profile and we fell back. */
  warning?: string;
}

export type MessagingProfileEnv = Record<string, string | undefined>;

/** Country name fragments libphonenumber-js cannot infer from a number. */
const COUNTRY_NAME_HINTS: Array<[RegExp, string]> = [
  [/IRELAND|\bIRL\b/, "IE"],
  [/UNITED KINGDOM|\bUK\b|\bGBR\b/, "GB"],
  [/UNITED STATES|\bUSA\b/, "US"],
];

/**
 * Normalise a country to an ISO alpha-2 code.
 *
 * Accepts an ISO code, an E.164 number, or free text, because the country
 * reaches us from three places that disagree: a Twenty `countryCode` field, a
 * phone number, and a human-typed address.
 */
export function normaliseCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  // A number is parsed rather than pattern-matched, so a malformed number
  // returns null instead of being guessed at from its first few digits.
  if (/^\+?\d/.test(raw)) {
    const parsed = parsePhoneNumberFromString(raw);
    return parsed?.country ?? null;
  }

  for (const [pattern, country] of COUNTRY_NAME_HINTS) {
    if (pattern.test(upper)) return country;
  }
  return null;
}

/** Country to profile id. Either shape is accepted. */
export type CountryProfileMap = Record<string, string> | string | null | undefined;

function parseCountryProfiles(input: CountryProfileMap): Map<string, string> {
  const map = new Map<string, string>();
  if (!input) return map;

  if (typeof input === "string") {
    // Compact form: `US=<id>,IE=<id>`. Whitespace is tolerated because this is
    // usually typed into an environment variable by hand.
    for (const pair of input.split(",")) {
      const [country, profileId] = pair.split("=").map((part) => part?.trim());
      if (!country || !profileId) continue;
      const normalised = normaliseCountry(country);
      if (normalised) map.set(normalised, profileId);
    }
    return map;
  }

  for (const [country, profileId] of Object.entries(input)) {
    const normalised = normaliseCountry(country);
    if (normalised && profileId) map.set(normalised, profileId);
  }
  return map;
}

export interface ResolveOptions {
  /** The recipient, as a number or a country, or both. */
  to?: string | null;
  recipientCountry?: string | null;
  /** The profile bound to the sending number, from the Twenty phone row. */
  numberProfileId?: string | null;
  /**
   * Countries that have a dedicated profile. Defaults to the mapping built from
   * the environment; pass the Convex `messagingProfiles` table once a
   * deployment is configured.
   */
  countryProfiles?: CountryProfileMap;
}

function defaultCountryMap(env: MessagingProfileEnv): Map<string, string> {
  const map = new Map<string, string>();

  // The explicit map is the general mechanism, so it is read first and the
  // per-country bootstrap only fills countries it does not already cover.
  const explicit = env[PROFILES.map];
  if (explicit) {
    for (const [country, profileId] of parseCountryProfiles(explicit)) {
      map.set(country, profileId);
    }
  }

  // The per-country variables are the documented bootstrap for the three
  // target countries. They are read into the same map as any other country so
  // nothing downstream special-cases them.
  const us = env[PROFILES.us];
  if (us && !map.has("US")) map.set("US", us);
  const ie = env[PROFILES.ie];
  if (ie) {
    if (!map.has("IE")) map.set("IE", ie);
    if (!map.has("GB")) map.set("GB", ie);
  }
  return map;
}

export function resolveMessagingProfile(
  env: MessagingProfileEnv,
  options: ResolveOptions = {},
): ProfileResolution {
  // A number that declares its own profile wins: the operator bound that
  // profile on purpose, and overriding it would break that decision.
  if (options.numberProfileId) {
    return {
      slot: null,
      profileId: options.numberProfileId,
      reason: "bound-to-number",
      country: normaliseCountry(options.recipientCountry) ?? normaliseCountry(options.to),
    };
  }

  const country =
    normaliseCountry(options.recipientCountry) ?? normaliseCountry(options.to);

  if (country) {
    const map =
      options.countryProfiles === undefined
        ? defaultCountryMap(env)
        : parseCountryProfiles(options.countryProfiles);
    const mapped = map.get(country);
    if (mapped) {
      return { slot: "country-map", profileId: mapped, reason: "recipient-country", country };
    }
  }

  const fallback = env[PROFILES.default];
  if (fallback) {
    const resolution: ProfileResolution = {
      slot: "default",
      profileId: fallback,
      reason: "default-fallback",
      country,
    };
    if (country) {
      resolution.warning =
        `No messaging profile is registered for ${country}. Falling back to the default profile, ` +
        `which is not registered for that jurisdiction, so the carrier may reject the message. ` +
        `Add ${country} to TELNYX_MESSAGING_PROFILES before sending there.`;
    }
    return resolution;
  }

  return { slot: null, profileId: null, reason: "no-profile-configured", country };
}

/** Every country that currently has a dedicated profile. */
export function configuredCountries(env: MessagingProfileEnv, extra?: CountryProfileMap): string[] {
  const map = extra === undefined ? defaultCountryMap(env) : parseCountryProfiles(extra);
  return [...map.keys()].sort();
}

/** Countries inside Blaster's intended reach that have no profile. */
export const TARGET_COUNTRIES = ["US", "GB", "IE"] as const;

export function uncoveredCountries(env: MessagingProfileEnv, extra?: CountryProfileMap): string[] {
  const covered = new Set(configuredCountries(env, extra));
  return TARGET_COUNTRIES.filter((country) => !covered.has(country));
}

/**
 * The profile bound to one of our own numbers, from the agency phone records.
 *
 * This is the lookup that makes a global `TELNYX_MESSAGING_PROFILE_ID`
 * unnecessary. A workspace that owns several numbers, each bought or assigned
 * against a different registration, cannot be described by one environment
 * variable: the profile belongs to the number, and the number's own record is
 * where that fact already lives. Reading it from `agencyPhones` first is also
 * why the profile travels with the number when a different surface reads the
 * same record, rather than being rediscovered per call.
 *
 * Returns null rather than falling back, so the caller can decide whether the
 * country rules should run. Numbers are compared in E.164 because the record
 * and the caller's `from` are rarely formatted the same way.
 */
export function profileBoundToNumber(
  rows: ReadonlyArray<{ phoneNumber?: string | null; messagingProfileId?: string | null }>,
  fromNumber: string | null | undefined,
): { profileId: string; phoneNumber: string } | null {
  const wanted = normalisePhone(fromNumber ?? "");
  if (!wanted) return null;
  for (const row of rows) {
    if (normalisePhone(row.phoneNumber ?? "") !== wanted) continue;
    const profileId = (row.messagingProfileId ?? "").trim();
    // A record with no profile is a real answer: this number is not registered
    // yet, which is a different problem from "the workspace has no profiles".
    if (profileId === "") return null;
    return { profileId, phoneNumber: wanted };
  }
  return null;
}

/** E.164 comparison key, tolerant of the formatting a number arrives in. */
function normalisePhone(value: string): string {
  const trimmed = value.trim();
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;
  try {
    return parsePhoneNumberFromString(trimmed, { defaultCountry: "US" })?.number ?? trimmed;
  } catch {
    return trimmed;
  }
}
