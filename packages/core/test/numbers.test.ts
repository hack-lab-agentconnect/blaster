import { describe, expect, test } from "vitest";
import {
  buildAvailableNumbersQuery,
  parseAvailableNumber,
  parseNumberOrder,
} from "../src/telnyx/numbers/helpers/numbers.ts";
import {
  fromAgencyPhoneRecord,
  planPhoneSync,
  toAgencyPhoneRecord,
} from "../src/twenty/phones/helpers/phones.ts";

describe("buildAvailableNumbersQuery", () => {
  test("encodes filters as filter[...] params", () => {
    const query = buildAvailableNumbersQuery({
      countryCode: "US",
      numberType: "local",
      features: ["sms", "voice"],
      limit: 5,
      contains: "555",
    });
    expect(query).toContain("filter%5Bcountry_code%5D=US");
    expect(query).toContain("filter%5Bphone_number_type%5D=local");
    expect(query).toContain("filter%5Blimit%5D=5");
    expect(query).toContain("contains");
  });

  test("empty filters encode to an empty string", () => {
    expect(buildAvailableNumbersQuery({})).toBe("");
  });
});

describe("parseAvailableNumber", () => {
  test("normalises regions, costs, and features", () => {
    const parsed = parseAvailableNumber({
      phone_number: "+19705555098",
      region_information: [
        { region_type: "country_code", region_name: "US" },
        { region_type: "locality", region_name: "Denver" },
      ],
      cost_information: { upfront_cost: "3.21", monthly_cost: "6.54", currency: "USD" },
      features: ["sms", "voice"],
      reservable: true,
      quickship: true,
      best_effort: false,
    });
    expect(parsed.phoneNumber).toBe("+19705555098");
    expect(parsed.countryCode).toBe("US");
    expect(parsed.locality).toBe("Denver");
    expect(parsed.upfrontCost).toBe("3.21");
    expect(parsed.features).toEqual(["sms", "voice"]);
  });

  test("tolerates missing fields", () => {
    const parsed = parseAvailableNumber({ phone_number: "+353871234567" });
    expect(parsed.countryCode).toBeNull();
    expect(parsed.features).toEqual([]);
  });
});

describe("parseNumberOrder", () => {
  test("normalises the order and its numbers", () => {
    const order = parseNumberOrder({
      id: "order-1",
      status: "success",
      customer_reference: "agent-7",
      messaging_profile_id: "profile-1",
      phone_numbers: [
        { id: "num-1", phone_number: "+19705555098", country_code: "US", status: "success" },
      ],
    });
    expect(order.id).toBe("order-1");
    expect(order.phoneNumbers).toHaveLength(1);
    expect(order.phoneNumbers[0]?.phoneNumber).toBe("+19705555098");
  });
});

describe("agencyPhones mapping", () => {
  test("a purchased number converts to a Twenty body", () => {
    const body = toAgencyPhoneRecord(
      { id: "num-1", phoneNumber: "+19705555098", countryCode: "US", numberType: "local", status: "success", requirementsMet: true },
      { messagingProfileId: "profile-1", orderId: "order-1" },
    );
    expect(body.phoneNumber).toBe("+19705555098");
    expect(body.messagingProfileId).toBe("profile-1");
    expect(body.orderId).toBe("order-1");
  });

  test("a Twenty row reads back, including SELECT composites", () => {
    const parsed = fromAgencyPhoneRecord({
      id: "row-1",
      phoneNumber: "+19705555098",
      messagingProfileId: "profile-1",
      status: { value: "active", label: "Active" },
    });
    expect(parsed.phoneNumber).toBe("+19705555098");
    expect(parsed.status).toBe("active");
  });

  test("sync is keyed on the E.164 number in both directions", () => {
    const plan = planPhoneSync(
      [{ phoneNumber: "+1" }, { phoneNumber: "+2" }],
      [{ phoneNumber: "+2" }, { phoneNumber: "+3" }],
    );
    expect(plan.toCreateInTwenty).toEqual([{ phoneNumber: "+1" }]);
    expect(plan.toStoreInConvex).toEqual([{ phoneNumber: "+3" }]);
  });
});
