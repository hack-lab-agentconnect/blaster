import { describe, expect, test } from "vitest";
import {
  conversationPairKey,
  normalizePhoneNumber,
  peerFromPairKey,
} from "../src/conversation/history/helpers/pair.ts";
import {
  nextStatus,
  shouldAdvanceStatus,
  statusRank,
} from "../src/conversation/history/helpers/status.ts";
import {
  eventTypeOf,
  isInboundEvent,
  readInboundMessage,
  readOutboundStatus,
  type TelnyxWebhookEvent,
} from "../src/conversation/history/helpers/telnyx-event.ts";

/** Shape copied from docs/telnyx/messaging/messages/receiving-webhooks.md. */
const INBOUND: TelnyxWebhookEvent = {
  data: {
    event_type: "message.received",
    id: "b301ed3f-1490-491f-995f-6e64e69674d4",
    occurred_at: "2024-01-15T20:16:07.588+00:00",
    payload: {
      id: "84cca175-9755-4859-b67f-4730d7f58aa3",
      text: "Hello from Telnyx!",
      // Inbound: from is an object, to is an ARRAY.
      from: { carrier: "T-Mobile USA", line_type: "long_code", phone_number: "+13125550001" },
      to: [
        {
          carrier: "Telnyx",
          line_type: "Wireless",
          phone_number: "+17735550002",
          status: "webhook_delivered",
        },
      ],
      media: [],
      received_at: "2024-01-15T20:16:07.503+00:00",
    },
  },
  meta: { attempt: 1, delivered_to: "https://example.com/webhooks" },
};

const MMS: TelnyxWebhookEvent = {
  data: {
    event_type: "message.received",
    id: "event-mms",
    payload: {
      id: "message-mms",
      text: "look",
      from: { phone_number: "+13125550001" },
      to: [{ phone_number: "+17735550002" }],
      media: [{ url: "https://media.telnyx.com/a.png", content_type: "image/png", size: 102400 }],
    },
  },
};

describe("normalizePhoneNumber", () => {
  test("keeps E.164 and canonicalizes everything else to it", () => {
    expect(normalizePhoneNumber("+13125550001")).toBe("+13125550001");
    expect(normalizePhoneNumber("13125550001")).toBe("+13125550001");
    expect(normalizePhoneNumber("(313) 255-5001")).toBe("+13132555001");
    expect(normalizePhoneNumber("  +44 20 7946 0958  ")).toBe("+442079460958");
  });

  test("an unparseable number is still stable rather than throwing", () => {
    expect(normalizePhoneNumber("not-a-number")).toBe("not-a-number");
    expect(normalizePhoneNumber("")).toBe("");
  });
});

describe("conversationPairKey", () => {
  test("is direction-independent, so inbound and outbound share a thread", () => {
    const inbound = conversationPairKey("+13125550001", "+17735550002");
    const outbound = conversationPairKey("+17735550002", "+13125550001");
    expect(inbound).toBe(outbound);
  });

  test("survives the formatting differences a human introduces", () => {
    expect(conversationPairKey("313-255-5001", "+1 773 555 0002")).toBe(
      conversationPairKey("+13132555001", "+17735550002"),
    );
  });

  test("two different peers are two different conversations", () => {
    expect(conversationPairKey("+13125550001", "+17735550002")).not.toBe(
      conversationPairKey("+13125550009", "+17735550002"),
    );
  });

  test("the peer is recoverable from the key", () => {
    const key = conversationPairKey("+13125550001", "+17735550002");
    expect(peerFromPairKey(key, "+17735550002")).toBe("+13125550001");
    expect(peerFromPairKey(key, "+13125550001")).toBe("+17735550002");
  });
});

describe("readInboundMessage", () => {
  test("reads the documented inbound event, including the array-shaped to", () => {
    const message = readInboundMessage(INBOUND);
    expect(message).not.toBeNull();
    expect(message).toMatchObject({
      telnyxMessageId: "84cca175-9755-4859-b67f-4730d7f58aa3",
      providerEventId: "b301ed3f-1490-491f-995f-6e64e69674d4",
      from: "+13125550001",
      to: "+17735550002",
      body: "Hello from Telnyx!",
    });
    expect(message?.receivedAt).toBe(Date.parse("2024-01-15T20:16:07.503+00:00"));
  });

  test("the event id, not the message id, is what dedupes a retry", () => {
    // Telnyx redelivers the same event id; a mapper that keyed on the message
    // id alone would store the retry as a second message.
    const retry = structuredClone(INBOUND);
    (retry.meta as { attempt: number }).attempt = 2;
    expect(readInboundMessage(retry)?.providerEventId).toBe(
      readInboundMessage(INBOUND)?.providerEventId,
    );
  });

  test("keeps MMS attachments with their content type", () => {
    expect(readInboundMessage(MMS)?.media).toEqual([
      { url: "https://media.telnyx.com/a.png", contentType: "image/png", size: 102400 },
    ]);
  });

  test("ignores outbound events and refuses a message with no peer", () => {
    expect(isInboundEvent({ data: { event_type: "message.finalized" } })).toBe(false);
    expect(eventTypeOf({ data: { event_type: "message.sent" } })).toBe("message.sent");
    expect(readInboundMessage({ data: { event_type: "message.sent" } })).toBeNull();
    expect(
      readInboundMessage({ data: { event_type: "message.received", payload: { text: "hi" } } }),
    ).toBeNull();
  });

  test("an empty body is a valid message, not a missing one", () => {
    const blank = structuredClone(INBOUND);
    blank.data!.payload!.text = "";
    expect(readInboundMessage(blank)?.body).toBe("");
  });
});

describe("readOutboundStatus", () => {
  test("collapses provider states to the displayed set", () => {
    expect(readOutboundStatus("queued")).toBe("queued");
    expect(readOutboundStatus("accepted")).toBe("queued");
    expect(readOutboundStatus("delivered")).toBe("delivered");
    expect(readOutboundStatus("failed")).toBe("failed");
    expect(readOutboundStatus("something-new")).toBe("unknown");
  });
});

describe("delivery status precedence", () => {
  test("advances through the normal progression", () => {
    expect(nextStatus("queued", "sent")).toBe("sent");
    expect(nextStatus("sent", "delivered")).toBe("delivered");
  });

  test("a redelivered earlier event never walks a message backwards", () => {
    // The case that matters: Telnyx redelivers, and a stale `sent` lands after
    // the finalizer already said `delivered`.
    expect(shouldAdvanceStatus("delivered", "sent")).toBe(false);
    expect(nextStatus("delivered", "sent")).toBeNull();
    expect(nextStatus("delivered", "queued")).toBeNull();
  });

  test("a failure after a send is still an advance", () => {
    expect(nextStatus("sent", "failed")).toBe("failed");
    expect(nextStatus("sent", "undelivered")).toBe("undelivered");
  });

  test("delivered outranks a contradicted failure, because the recipient has it", () => {
    expect(statusRank("delivered")).toBeGreaterThan(statusRank("failed"));
    expect(nextStatus("failed", "delivered")).toBe("delivered");
  });

  test("the outcome does not depend on arrival order", () => {
    const apply = (current: string, incoming: string) => nextStatus(current, incoming) ?? current;
    const forward = apply(apply(apply("queued", "sent"), "failed"), "delivered");
    const reversed = apply(apply(apply("queued", "delivered"), "failed"), "sent");
    expect(forward).toBe("delivered");
    expect(reversed).toBe("delivered");
  });

  test("an unrecognized state is treated as no information at all", () => {
    expect(statusRank("brand-new-state")).toBe(0);
    expect(nextStatus("queued", "brand-new-state")).toBeNull();
    expect(nextStatus(null, "queued")).toBe("queued");
  });
});
