import { describe, expect, test } from "vitest";
import {
  PROFILES,
  configuredCountries,
  normaliseCountry,
  resolveMessagingProfile,
  uncoveredCountries,
} from "../src/telnyx/messaging/helpers/profile.ts";

const env = {
  [PROFILES.default]: "profile-default",
  [PROFILES.us]: "profile-us",
  [PROFILES.ie]: "profile-ie",
};

// Real, structurally valid numbers. The library rejects reserved and fictional
// ranges such as 555, so a fixture has to be a number a carrier could issue.
const US = "+14155552671";
const IE = "+353871234567";
const GB = "+447400123456";

describe("normaliseCountry", () => {
  test("passes through ISO alpha-2 codes", () => {
    expect(normaliseCountry("US")).toBe("US");
    expect(normaliseCountry("ie")).toBe("IE");
  });

  test("resolves E.164 numbers through the library, not a hand-kept table", () => {
    expect(normaliseCountry(US)).toBe("US");
    expect(normaliseCountry(IE)).toBe("IE");
    expect(normaliseCountry(GB)).toBe("GB");
  });

  test("resolves countries outside the three the profiles bootstrap", () => {
    expect(normaliseCountry("+4915112345678")).toBe("DE");
    expect(normaliseCountry("+8613800138000")).toBe("CN");
  });

  test("maps free text", () => {
    expect(normaliseCountry("Ireland")).toBe("IE");
    expect(normaliseCountry("United States")).toBe("US");
    expect(normaliseCountry("united kingdom")).toBe("GB");
  });

  test("an unresolvable number is null rather than a guess", () => {
    // A number in a reserved range cannot be attributed to a country, and
    // guessing from its first digits is exactly the bug this replaced.
    expect(normaliseCountry("+15550012345")).toBeNull();
    expect(normaliseCountry("+999123456")).toBeNull();
  });

  test("returns null for nothing usable", () => {
    expect(normaliseCountry(null)).toBeNull();
    expect(normaliseCountry("")).toBeNull();
    expect(normaliseCountry("   ")).toBeNull();
  });
});

describe("resolveMessagingProfile", () => {
  test("a US recipient gets the 10DLC profile", () => {
    const result = resolveMessagingProfile(env, { to: US });
    expect(result.slot).toBe("country-map");
    expect(result.profileId).toBe("profile-us");
    expect(result.reason).toBe("recipient-country");
    expect(result.country).toBe("US");
  });

  test("Irish and UK recipients share the alphanumeric profile", () => {
    expect(resolveMessagingProfile(env, { to: IE }).profileId).toBe("profile-ie");
    expect(resolveMessagingProfile(env, { to: GB }).profileId).toBe("profile-ie");
  });

  test("an explicit recipient country wins over parsing the number", () => {
    const result = resolveMessagingProfile(env, { to: US, recipientCountry: "IE" });
    expect(result.profileId).toBe("profile-ie");
  });

  test("a profile bound to the sending number overrides the country rule", () => {
    const result = resolveMessagingProfile(env, { to: IE, numberProfileId: "bound-profile" });
    expect(result.profileId).toBe("bound-profile");
    expect(result.reason).toBe("bound-to-number");
  });

  test("any country can be mapped without a code change", () => {
    const result = resolveMessagingProfile(env, {
      to: "+4915112345678",
      countryProfiles: "DE=profile-de,IE=profile-ie",
    });
    expect(result.profileId).toBe("profile-de");
    expect(result.country).toBe("DE");
  });

  test("a country map also accepts an object", () => {
    const result = resolveMessagingProfile(env, {
      to: "+8613800138000",
      countryProfiles: { CN: "profile-cn" },
    });
    expect(result.profileId).toBe("profile-cn");
  });

  test("a country with no profile falls back and says so", () => {
    const result = resolveMessagingProfile(env, { to: "+4915112345678" });
    expect(result.profileId).toBe("profile-default");
    expect(result.reason).toBe("default-fallback");
    expect(result.warning).toContain("DE");
  });

  test("a missing country profile is reported as a deployment gap", () => {
    const result = resolveMessagingProfile({ [PROFILES.default]: "only-default" }, { to: US });
    expect(result.reason).toBe("default-fallback");
    expect(result.warning).toContain("TELNYX_MESSAGING_PROFILES");
  });

  test("an unresolvable recipient uses the default and is not blamed on a country", () => {
    const result = resolveMessagingProfile(env, { to: "+999123456" });
    expect(result.reason).toBe("default-fallback");
    expect(result.country).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  test("no profiles at all is a distinct outcome from a fallback", () => {
    const result = resolveMessagingProfile({}, { to: US });
    expect(result.profileId).toBeNull();
    expect(result.reason).toBe("no-profile-configured");
  });

  test("an unresolvable recipient is not silently dropped", () => {
    const result = resolveMessagingProfile(env, { to: "+999123456" });
    expect(result.profileId).toBe("profile-default");
  });
});

describe("coverage reporting", () => {
  test("configured countries come from the profiles that are set", () => {
    expect(configuredCountries(env)).toEqual(["GB", "IE", "US"]);
  });

  test("an explicit country map replaces the bootstrap", () => {
    expect(configuredCountries(env, "DE=profile-de")).toEqual(["DE"]);
  });

  test("uncovered countries are the ones with no profile", () => {
    expect(uncoveredCountries({ [PROFILES.default]: "d", [PROFILES.us]: "u" })).toEqual(["GB", "IE"]);
  });
});
