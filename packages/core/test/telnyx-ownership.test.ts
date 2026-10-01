import { describe, expect, test } from "vitest";
import { resolveOwnedDestination } from "../src/telnyx/messaging/helpers/ownership.ts";
import type { OwnedPhoneNumber } from "../src/telnyx/numbers/helpers/numbers.ts";

/**
 * The webhook is a public URL, so its `to` field is attacker-controlled. These
 * tests pin the rule that stops a forged event from entering our history, and
 * the fail-closed behaviour that keeps it true when the registries are empty.
 */
const TELNYX: OwnedPhoneNumber[] = [
  { id: "num-1", phoneNumber: "+17735550002", messagingProfileId: "prof-1", status: "active" },
  { id: "num-2", phoneNumber: "+13132555001", messagingProfileId: null, status: "active" },
];

describe("resolveOwnedDestination", () => {
  test("accepts a number the Telnyx account owns, and returns its profile", () => {
    const result = resolveOwnedDestination("+17735550002", { telnyx: TELNYX });
    expect(result).toEqual({
      status: "owned",
      destination: {
        phoneNumber: "+17735550002",
        source: "telnyx",
        telnyxNumberId: "num-1",
        messagingProfileId: "prof-1",
        status: "active",
      },
    });
  });

  test("normalizes before matching, so formatting cannot dodge or fake a match", () => {
    expect(resolveOwnedDestination("1 (773) 555-0002", { telnyx: TELNYX }).status).toBe("owned");
    // A number that is only equal after normalization is still a real number we
    // own; one that merely looks similar is not.
    expect(resolveOwnedDestination("+17735550003", { telnyx: TELNYX }).status).toBe("not-owned");
  });

  test("rejects a number nobody owns, and says how many rows it checked", () => {
    const result = resolveOwnedDestination("+13125550001", { telnyx: TELNYX });
    expect(result).toEqual({ status: "not-owned", phoneNumber: "+13125550001", checked: 2 });
  });

  test("consults the mirrors when Telnyx does not have it yet", () => {
    const twenty = [{ phoneNumber: "+447700900123", telnyxNumberId: "num-9", messagingProfileId: "prof-uk" }];
    const result = resolveOwnedDestination("+447700900123", { telnyx: [], twenty });
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.destination.source).toBe("twenty");
      expect(result.destination.messagingProfileId).toBe("prof-uk");
    }
  });

  test("Telnyx wins over the mirrors for the same number", () => {
    const twenty = [{ phoneNumber: "+17735550002", messagingProfileId: "stale-profile" }];
    const result = resolveOwnedDestination("+17735550002", { telnyx: TELNYX, twenty });
    if (result.status !== "owned") throw new Error("expected owned");
    expect(result.destination.source).toBe("telnyx");
    expect(result.destination.messagingProfileId).toBe("prof-1");
  });

  test("consults the Convex ledger when neither provider registry has the number", () => {
    // A number a pool added to the ledger but that has not reached Telnyx or
    // Twenty yet: its inbound replies must still be stored.
    const convex = [{ phoneNumber: "+15551230000", status: "active", messagingProfileId: "prof-5" }];
    const result = resolveOwnedDestination("+15551230000", { telnyx: [], twenty: [], convex });
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.destination.source).toBe("convex");
      expect(result.destination.messagingProfileId).toBe("prof-5");
    }
  });

  test("a configured-but-empty registry is still a registry", () => {
    // Not "no-sources": there is a registry, and it does not have the number.
    expect(resolveOwnedDestination("+15551230000", { convex: [] })).toMatchObject({
      status: "not-owned",
    });
  });

  test("fails closed when no registry is configured at all", () => {
    // A deployment with no number registry has no legitimate inbound either, so
    // "unknown" must never read as "owned".
    expect(resolveOwnedDestination("+17735550002", {})).toEqual({
      status: "no-sources",
      phoneNumber: "+17735550002",
    });
  });

  test("an empty destination is never owned", () => {
    expect(resolveOwnedDestination("", { telnyx: TELNYX }).status).toBe("not-owned");
  });
});
