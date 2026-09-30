import { describe, expect, test } from "vitest";
import {
  CALL_EVENT_TYPES,
  analysisPatch,
  callIdOf,
  findCallByTelnyxId,
  findOrphanCall,
  isCallEvent,
  isFieldExistsError,
  labelFor,
  newCallRecord,
  recordingIdOf,
  recordingPatch,
  recordingUrlOf,
  relationJoinColumn,
  transcriptOf,
  transcriptionPatch,
} from "../src/twenty/agencyCall/index.ts";
import { RELATION_FIELDS, TEXT_FIELDS } from "../src/twenty/agencyCall/helpers/schema.ts";
import type { CallRecord } from "../src/twenty/agencyCall/index.ts";

const AT = new Date("2026-03-01T12:00:00.000Z");

describe("event classification", () => {
  test("the three call events are recognised", () => {
    for (const type of CALL_EVENT_TYPES) expect(isCallEvent(type)).toBe(true);
  });

  test("a messaging event is not a call event", () => {
    expect(isCallEvent("message.received")).toBe(false);
    expect(isCallEvent("")).toBe(false);
  });
});

describe("payload aliases", () => {
  test("the call control id, with the session id as a fallback", () => {
    expect(callIdOf({ call_control_id: "cc-1" })).toBe("cc-1");
    expect(callIdOf({ call_session_id: "cs-1" })).toBe("cs-1");
    expect(callIdOf({})).toBeUndefined();
  });

  test("the recording id, across the singular and array spellings", () => {
    expect(recordingIdOf({ recording_id: "r-1" })).toBe("r-1");
    expect(recordingIdOf({ recording_ids: ["r-2", "r-3"] })).toBe("r-2");
    expect(recordingIdOf({ recording_ids: [] })).toBeUndefined();
  });

  test("mp3 is preferred over wav, because it plays everywhere", () => {
    expect(recordingUrlOf({ recording_urls: { mp3: "a.mp3", wav: "a.wav" } })).toBe("a.mp3");
    expect(recordingUrlOf({ recording_urls: { wav: "a.wav" } })).toBe("a.wav");
  });

  test("the transcript, across every spelling the payload has used", () => {
    expect(transcriptOf({ transcript: "t" })).toBe("t");
    expect(transcriptOf({ transcription_text: "t" })).toBe("t");
    expect(transcriptOf({ text: "t" })).toBe("t");
    expect(transcriptOf({ transcription: { text: "t" } })).toBe("t");
    expect(transcriptOf({})).toBeUndefined();
  });
});

describe("patches", () => {
  test("a saved recording marks the transcription pending and attaches what it has", () => {
    expect(
      recordingPatch({ recording_id: "r-1", recording_urls: { mp3: "a.mp3" } }),
    ).toEqual({
      transcriptionStatus: "PENDING",
      telnyxRecordingId: "r-1",
      recordingUrl: "a.mp3",
    });
  });

  test("a recording with no id still moves the row to pending", () => {
    expect(recordingPatch({})).toEqual({ transcriptionStatus: "PENDING" });
  });

  test("a saved transcription marks it ready and stores the text", () => {
    expect(transcriptionPatch({ transcript: "hello" })).toEqual({
      transcriptionStatus: "READY",
      transcript: "hello",
    });
  });

  test("a transcription with no text still marks it ready", () => {
    expect(transcriptionPatch({})).toEqual({ transcriptionStatus: "READY" });
  });

  test("an analysis is stored on the ai fields and mirrored into the summary", () => {
    const patch = analysisPatch(
      {
        summary: "Went well",
        sentiment: "POSITIVE",
        score: 82,
        scores: { conversion: 4, politeness: 5, questioning: 4, engagement: 4, sentiment: 5 },
        keyPoints: ["Asked about budget"],
        confidence: 0.8,
        model: "gpt-4o-mini",
      },
      AT,
    );
    expect(patch.aiSentiment).toBe("POSITIVE");
    expect(patch.aiAnalyzedAt).toBe("2026-03-01T12:00:00.000Z");
    expect(patch.aiKeyPoints).toBe('["Asked about budget"]');
    expect(patch.aiScores).toContain('"conversion":4');
    expect(patch.summary).toBe("Went well");
  });
});

describe("newCallRecord", () => {
  test("stamps the call control id and defaults an absent direction to UNKNOWN", () => {
    const record = newCallRecord({ call_control_id: "cc-1", from: "+15551234567" }, AT);
    expect(record.telnyxCallId).toBe("cc-1");
    // Not INBOUND: Telnyx does not put direction on every payload, and a wrong
    // direction silently mis-files the call in every report filtered by it.
    expect(record.direction).toBe("UNKNOWN");
    expect(record.name).toContain("+15551234567");
  });

  test("keeps a direction the event does supply", () => {
    expect(newCallRecord({ direction: "OUTBOUND" }, AT).direction).toBe("OUTBOUND");
  });
});

describe("matching a call to an event", () => {
  const rows: CallRecord[] = [
    { id: "c-1", telnyxCallId: "cc-1" },
    { id: "c-2", telnyxCallId: "cc-2" },
  ];

  test("by call control id", () => {
    expect(findCallByTelnyxId(rows, "cc-2")?.id).toBe("c-2");
    expect(findCallByTelnyxId(rows, "cc-9")).toBeNull();
  });

  test("an orphan is the newest unstamped row with the same parties", () => {
    const orphans: CallRecord[] = [
      { id: "old", fromNumber: "+1", toNumber: "+2", createdAt: "2026-03-01T11:00:00.000Z" },
      { id: "new", fromNumber: "+1", toNumber: "+2", createdAt: "2026-03-01T11:55:00.000Z" },
    ];
    expect(findOrphanCall(orphans, { from: "+1", to: "+2" }, AT)?.id).toBe("new");
  });

  test("a row that already has a recording is never an orphan", () => {
    const stamped: CallRecord[] = [
      {
        id: "done",
        fromNumber: "+1",
        recordingUrl: "a.mp3",
        createdAt: "2026-03-01T11:59:00.000Z",
      },
    ];
    expect(findOrphanCall(stamped, { from: "+1" }, AT)).toBeNull();
  });

  test("a row outside the window is too old to adopt", () => {
    const stale: CallRecord[] = [{ id: "stale", fromNumber: "+1", createdAt: "2026-03-01T09:00:00.000Z" }];
    expect(findOrphanCall(stale, { from: "+1" }, AT)).toBeNull();
  });

  test("mismatched parties do not match, and no parties at all cannot match", () => {
    const rows2: CallRecord[] = [{ id: "c", fromNumber: "+9", createdAt: "2026-03-01T11:59:00.000Z" }];
    expect(findOrphanCall(rows2, { from: "+1" }, AT)).toBeNull();
    expect(findOrphanCall(rows2, {}, AT)).toBeNull();
  });
});

describe("schema helpers", () => {
  test("a label reads the way Twenty shows it, acronyms included", () => {
    expect(labelFor("telnyxCallId")).toBe("Telnyx Call ID");
    expect(labelFor("aiSentiment")).toBe("Ai Sentiment");
    expect(labelFor("name")).toBe("Name");
  });

  test("both phrasings of a taken name count as already present", () => {
    expect(isFieldExistsError(new Error("Field name already exists"))).toBe(true);
    expect(isFieldExistsError(new Error("label already used by another field"))).toBe(true);
    expect(isFieldExistsError(new Error("permission denied"))).toBe(false);
    expect(isFieldExistsError(undefined)).toBe(false);
  });

  test("relations are declared under their base name, never as an Id text column", () => {
    const names = TEXT_FIELDS;
    for (const relation of RELATION_FIELDS) {
      expect(names).not.toContain(relation.name);
      // This is the whole point: a TEXT field called agencyPhoneId would shadow
      // the real relation with a useless column.
      expect(names).not.toContain(`${relation.name}Id`);
      expect(relationJoinColumn(relation.name)).toBe(`${relation.name}Id`);
    }
  });
});
