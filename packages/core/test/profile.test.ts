import { describe, expect, test } from "vitest";
import {
  PROFILES,
  configuredCountries,
  normaliseCountry,
  profileBoundToNumber,
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

/**
 * The profile belongs to the number, not to the environment.
 *
 * A workspace that owns several numbers has one registration per number, so a
 * single global variable either lies about the rest or forces every number onto
 * the same profile. These cases are the difference between "we read the
 * workspace" and "we happen to be configured for one number".
 */
describe("profileBoundToNumber", () => {
  const ROWS = [
    { phoneNumber: "+12725550143", messagingProfileId: "prof-us-1" },
    { phoneNumber: "+353871234567", messagingProfileId: "prof-ie-1" },
    { phoneNumber: "+442079460958", messagingProfileId: "" },
  ];

  test("a record with a profile wins, with no environment involved", () => {
    expect(profileBoundToNumber(ROWS, "+12725550143")).toEqual({
      profileId: "prof-us-1",
      phoneNumber: "+12725550143",
    });
    expect(profileBoundToNumber(ROWS, "+353871234567")?.profileId).toBe("prof-ie-1");
  });

  test("two numbers get their own profiles, not one shared one", () => {
    expect(profileBoundToNumber(ROWS, "+12725550143")?.profileId).not.toBe(
      profileBoundToNumber(ROWS, "+353871234567")?.profileId,
    );
  });

  test("matching survives the formatting a caller supplies", () => {
    expect(profileBoundToNumber(ROWS, "1 (272) 555-0143")?.profileId).toBe("prof-us-1");
    expect(profileBoundToNumber(ROWS, "+353 87 123 4567")?.profileId).toBe("prof-ie-1");
  });

  test("a record with no profile is a real answer, not a miss", () => {
    // This number is not registered yet, which the operator needs to see. The
    // country rules and the global variable may still cover it, so this returns
    // null and lets resolveMessagingProfile decide.
    expect(profileBoundToNumber(ROWS, "+442079460958")).toBeNull();
  });

  test("a number nobody recorded has no bound profile", () => {
    expect(profileBoundToNumber(ROWS, "+15555550100")).toBeNull();
    expect(profileBoundToNumber([], "+12725550143")).toBeNull();
    expect(profileBoundToNumber(ROWS, "")).toBeNull();
    expect(profileBoundToNumber(ROWS, null)).toBeNull();
  });

  test("the bound profile then beats every environment variable", () => {
    const resolution = resolveMessagingProfile(
      { TELNYX_MESSAGING_PROFILE_ID: "env-default" },
      { to: "+353871234567", numberProfileId: profileBoundToNumber(ROWS, "+12725550143")?.profileId },
    );
    expect(resolution.reason).toBe("bound-to-number");
    expect(resolution.profileId).toBe("prof-us-1");
  });

  test("with no record, the environment still resolves the send", () => {
    const resolution = resolveMessagingProfile({ TELNYX_MESSAGING_PROFILE_ID: "env-default" }, {
      to: "+353871234567",
    });
    expect(resolution.profileId).toBe("env-default");
  });
});
