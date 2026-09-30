import { describe, expect, test } from "vitest";
import { derivePhoneState } from "../src/telnyx/messaging/helpers/phone-derived-state.ts";

// Fixture numbers are chosen against the `areacodes` table, which is keyed on
// the 3-digit area code. A number is only as geographic as its NPA: 215 is
// Pennsylvania, 312 is Illinois, 917 is the Boston area, 800 is toll-free
// with no state, 340 (US Virgin Islands) carries a lower-case raw string that
// the helper must normalise, and 555 is fictional (not in the table). Each
// fixture uses middle digits `libphonenumber-js` accepts as a valid local
// number, so the parser reaches the area-code lookup rather than rejecting it.

describe("derivePhoneState", () => {
  test("a US geographic number resolves to its area-code state", async () => {
    const result = await derivePhoneState("+12154550123");
    expect(result.countryCode).toBe("US");
    expect(result.stateCode).toBe("PA");
    expect(result.stateName).toBe("Pennsylvania");
    expect(result.city).toBe("Levittown");
    expect(result.tollFree).toBe(false);
    expect(result.complete).toBe(true);
  });

  test("an area code that covers multiple locations resolves to its primary state", async () => {
    // 917 is the Boston-area code (NANP 917). The table maps it to a single
    // representative entry; what matters is that a single NPA yields one
    // primary state, never a set of states.
    const result = await derivePhoneState("+19174550123");
    expect(result.stateCode).toBe("NY");
    expect(result.stateName).toBe("New York");
  });

  test("a toll-free number has no state and is flagged toll-free", async () => {
    const result = await derivePhoneState("+18004550123");
    expect(result.countryCode).toBe("US");
    expect(result.stateCode).toBeNull();
    expect(result.stateName).toBeNull();
    expect(result.city).toBeNull();
    expect(result.tollFree).toBe(true);
    expect(result.complete).toBe(false);
  });

  test("a mobile-only number under a geographic NPA resolves to that NPA's state", async () => {
    // US mobiles are not separately typed; a mobile number in the 312 NPA is
    // an Illinois number. This is the honest mobile/non-geographic answer the
    // dataset can give: the NPA's state.
    const result = await derivePhoneState("+13124550123");
    expect(result.stateCode).toBe("IL");
    expect(result.stateName).toBe("Illinois");
    expect(result.tollFree).toBe(false);
  });

  test("an invalid number returns null state, not a guess", async () => {
    // A 555 number is the fictional range: the parser reads it but rejects it,
    // so there is no country and no state to report.
    const result = await derivePhoneState("+15554010123");
    expect(result.countryCode).toBeNull();
    expect(result.stateCode).toBeNull();
    expect(result.stateName).toBeNull();
    expect(result.complete).toBe(false);
  });

  test("an international (non-NANP) number returns its country but no state", async () => {
    const result = await derivePhoneState("+353871234567");
    expect(result.countryCode).toBe("IE");
    expect(result.stateCode).toBeNull();
    expect(result.stateName).toBeNull();
    expect(result.tollFree).toBe(false);
  });

  test("a valid US number whose area code is not in the table returns null state", async () => {
    // 204 is a real, valid NPA that this table does not carry. The country is
    // still reported, and the state stays null rather than being invented.
    const result = await derivePhoneState("+12044010001");
    expect(result.stateCode).toBeNull();
    expect(result.stateName).toBeNull();
    expect(result.city).toBeNull();
    expect(result.tollFree).toBe(false);
    expect(result.complete).toBe(false);
  });

  test("a NANP territory number resolves through the same area-code table", async () => {
    // +1 340 is a US Virgin Islands NPA. The phone parser reports the territory
    // ("VI"), not "US", and the table carries it, so the state resolves.
    const result = await derivePhoneState("+13404010001");
    expect(result.stateCode).toBe("VI");
    expect(result.stateName).toBe("Us Virgin Islands");
    expect(result.complete).toBe(true);
  });

  test("a state/city string that needs normalising is title-cased", async () => {
    // 340 (US Virgin Islands) maps to the raw strings "us virgin islands" and
    // "charlotte amalie" in the table; the helper must return title-cased
    // values, not the inconsistent source casing.
    const result = await derivePhoneState("+13404010001");
    expect(result.stateName).toBe("Us Virgin Islands");
    expect(result.city).toBe("Charlotte Amalie");
  });
});
