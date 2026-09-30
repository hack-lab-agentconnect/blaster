/**
 * Derive US state/city data from a phone number, offline.
 *
 * A phone number in this system has two geographic facts that are easy to
 * confuse, and this module keeps them apart:
 *
 * - the **country**, which the number itself carries and `libphonenumber-js`
 *   reads reliably (the dial code), and
 * - the **state and city**, which are NOT carried in the number and are looked
 *   up offline against the `areacodes` table, keyed on the 3-digit area code.
 *
 * US state is a property of the area code, not of the full number: a 215
 * number is a Pennsylvania number whether it is in Philadelphia, Levittown,
 * or anywhere the 215 NPA reaches. `areacodes` is a small MIT dataset
 * (~358 area codes) bundled and read from disk at import, so the lookup is
 * synchronous, needs no network and no API key, and works in every surface.
 *
 * The two libraries compose: `libphonenumber-js` parses, validates, and tells
 * us the country; only when the number is a NANP (US/CA) number do we hand its
 * area code to `areacodes`. Anything else returns structured `null` state so a
 * caller can show "no state known" rather than a wrong one.
 *
 * What `areacodes` does NOT do, and what this module therefore will not claim:
 * - it keys on the 3-digit area code, so an area code that technically spans
 *   two states resolves to its **primary** state, not a set of states.
 * - it does not distinguish mobile from local; both resolve to the NPA's state.
 * - toll-free NPAs (800/833/844/855/866/877/888/899) have no state, so they
 *   resolve to `null` state and are flagged as toll-free.
 *
 * The state/city strings in the raw table are inconsistently cased
 * ("Michigan", "us virgin islands", ...), so this module normalises them to
 * canonical title case before returning, keyed off the USPS code where one
 * exists.
 */

import { parsePhoneNumber } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";
// @ts-expect-error: areacodes ships CJS without type declarations.
import AreaCodes from "areacodes";

const areaCodes = new AreaCodes();

/** The shape a geographic phone lookup returns. */
export interface PhoneDerivedState {
  /** The ISO-3166 country the number belongs to, from the phone parser. */
  countryCode: CountryCode | null;
  /** USPS 2-letter state code, when the area code resolves to one. */
  stateCode: string | null;
  /** The human state name, title-cased, when the area code resolves to one. */
  stateName: string | null;
  /** A representative city for the area code, when the table has one. */
  city: string | null;
  /**
   * True when the number is a NANP toll-free number, which carries no state.
   * Lets a caller say "toll-free, no state" instead of a bare null.
   */
  tollFree: boolean;
  /** True when every field above could be read from the number. */
  complete: boolean;
}

/**
 * The North American Numbering Plan, by the country/territory code the phone
 * parser reports. `libphonenumber-js` returns the *territory* for a NANP
 * territory number rather than "US": a +1 340 (US Virgin Islands) number comes
 * back as `VI`, and a +1 204 number can come back as `CA`. Only the `+1` plan
 * shares the US area-code space, so all of these are the one region this table
 * can answer for; anything else is outside it and gets null state.
 */
const NANP: readonly CountryCode[] = [
  "US",
  "CA",
  "AG", // Antigua and Barbuda
  "AI", // Anguilla
  "AS", // American Samoa
  "BB", // Barbados
  "BM", // Bermuda
  "BS", // Bahamas
  "DM", // Dominica
  "DO", // Dominican Republic
  "GD", // Grenada
  "GU", // Guam
  "JM", // Jamaica
  "KN", // Saint Kitts and Nevis
  "KY", // Cayman Islands
  "LC", // Saint Lucia
  "MP", // Northern Mariana Islands
  "MS", // Montserrat
  "PR", // Puerto Rico
  "SX", // Sint Maarten
  "TC", // Turks and Caicos
  "TT", // Trinidad and Tobago
  "VC", // Saint Vincent and the Grenadines
  "VG", // British Virgin Islands
  "VI", // US Virgin Islands
];

/** Title-case a raw state/city string, so "michigan" becomes "Michigan". */
function titleCase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const words = trimmed
    .toLowerCase()
    .split(" ")
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

/**
 * Read a known number out of the bundled table. Returns null when the number
 * is not in the table (e.g. a 555 fictional number or a code this table does
 * not carry). The `areacodes` lookup is keyed on the area code but validates
 * a full 10-digit local number, so the national number is passed in whole.
 */
function lookupAreaCode(nationalNumber: string) {
  return new Promise<{
    type: string;
    city: string | null;
    state: string | null;
    stateCode: string | null;
  } | null>((resolve) => {
    areaCodes.get(nationalNumber, (error: unknown, data: any) => {
      if (error || !data) {
        resolve(null);
        return;
      }
      resolve({
        type: data.type ?? "",
        city: (data.city as string | null) ?? null,
        state: (data.state as string | null) ?? null,
        stateCode: (data.stateCode as string | null) ?? null,
      });
    });
  });
}

/**
 * Derive the geographic state/city of a phone number.
 *
 * The flow is: parse and validate with `libphonenumber-js`; if the number is a
 * NANP number, pull its area code and look it up in the offline `areacodes`
 * table. Anything that cannot be read reliably returns `null` state with the
 * country (when known), never a guessed one.
 */
export async function derivePhoneState(
  input: string,
  defaultCountry: CountryCode = "US",
): Promise<PhoneDerivedState> {
  const empty: PhoneDerivedState = {
    countryCode: null,
    stateCode: null,
    stateName: null,
    city: null,
    tollFree: false,
    complete: false,
  };
  const raw = (input ?? "").trim();
  if (raw === "") return empty;

  const parsed = parsePhoneNumber(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    // Still surface the country if the parser read a dial code, so a caller
    // can say "this looked like a +353 number, and I have no state for it".
    return { ...empty, countryCode: parsed?.country ?? null };
  }

  const countryCode = parsed.country ?? defaultCountry;
  const base: PhoneDerivedState = { ...empty, countryCode };

  // Only NANP numbers have US state; a Canadian or foreign number resolves to
  // no state in this table rather than a wrong one.
  if (!NANP.includes(countryCode)) {
    return { ...base, complete: false };
  }

  // The `areacodes` table is keyed on the 3-digit area code, but its `get()`
  // validates a full 10-digit local number; pass the national number through
  // it (it strips the area code internally) rather than the bare NPA, which
  // would fail that validation.
  const row = await lookupAreaCode(parsed.nationalNumber);
  if (!row) return { ...base, complete: false };

  if (row.type === "toll-free") {
    return { ...base, tollFree: true, complete: false };
  }

  const stateCode = row.stateCode ?? null;
  const stateName = titleCase(row.state);
  const city = titleCase(row.city);
  return {
    ...base,
    stateCode,
    stateName,
    city,
    tollFree: false,
    complete: Boolean(stateCode && stateName),
  };
}
