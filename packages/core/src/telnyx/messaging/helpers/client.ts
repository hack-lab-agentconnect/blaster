/**
 * Telnyx messaging over the official `telnyx` SDK.
 *
 * The install was already a declared dependency (`telnyx@7.24.0`) but nothing
 * imported it, so every call site hand-rolled fetch instead. This module is
 * now the single SDK-backed transport: `client.messages.send` for sends and
 * `client.messagingProfiles.list` for profile reads.
 *
 * A messaging profile is attached to the sending number through the profile id
 * in the request body, which is why selection happens in `profile.ts` before
 * the call rather than being left to Telnyx to guess.
 */

import Telnyx from "telnyx";

export type TelnyxClient = InstanceType<typeof Telnyx>;

export class TelnyxError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    // The API key is never included in the message, only the provider's own
    // text, so an error can be logged without leaking the credential.
    super(`Telnyx ${status}: ${detail}`);
    this.name = "TelnyxError";
    this.status = status;
  }
}

/**
 * Map anything the SDK throws onto TelnyxError. The SDK's own error classes
 * carry numeric `.status`; anything else is a 500 with a truncated message.
 */
export function toTelnyxError(error: unknown): TelnyxError {
  if (error instanceof TelnyxError) return error;
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : 500;
  const detail = error instanceof Error ? error.message : String(error);
  return new TelnyxError(status, detail.slice(0, 300));
}

let cachedClient: { apiKey: string; client: TelnyxClient } | null = null;

/** Build (and memoise per key) the official SDK client. */
export function officialClient(apiKey: string): TelnyxClient {
  if (cachedClient?.apiKey === apiKey) return cachedClient.client;
  const client = new Telnyx({ apiKey }) as TelnyxClient;
  cachedClient = { apiKey, client };
  return client;
}

export interface SendMessageInput {
  apiKey: string;
  from: string;
  to: string;
  text: string;
  messagingProfileId: string | null;
  /** Optional client reference, echoed back on status webhooks. */
  clientReference?: string;
}

export interface SendMessageResult {
  id: string;
  status: string;
  from: string;
  to: string;
  profileId: string | null;
}

function scalar(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function phoneNumberOf(value: unknown, fallback: string): string {
  if (typeof value === "string") return scalar(value, fallback);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry !== "") return entry;
      if (entry && typeof entry === "object") {
        const number = (entry as Record<string, unknown>).phone_number;
        if (typeof number === "string" && number !== "") return number;
      }
    }
    return fallback;
  }
  if (value && typeof value === "object") {
    const number = (value as Record<string, unknown>).phone_number;
    if (typeof number === "string" && number !== "") return number;
  }
  return fallback;
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  // The installed SDK's send params have no client_reference field. Failing
  // loudly beats silently dropping correlation data the caller asked for.
  if (input.clientReference) {
    throw new TelnyxError(400, "client_reference is not supported by the installed SDK send path");
  }
  try {
    const client = officialClient(input.apiKey);
    const response = await client.messages.send({
      from: input.from,
      to: input.to,
      text: input.text,
      ...(input.messagingProfileId ? { messaging_profile_id: input.messagingProfileId } : {}),
    });
    const data = (response?.data ?? {}) as Record<string, unknown>;
    return {
      id: scalar(data.id, ""),
      status: scalar(data.status, "unknown"),
      from: phoneNumberOf(data.from, input.from),
      to: phoneNumberOf(data.to, input.to),
      profileId: input.messagingProfileId,
    };
  } catch (error) {
    throw toTelnyxError(error);
  }
}

export interface MessagingProfileSummary {
  id: string;
  name: string | null;
  whitelistedDestinations: string[] | null;
  alphaSender: string | null;
}

export async function listMessagingProfiles(apiKey: string): Promise<MessagingProfileSummary[]> {
  try {
    const client = officialClient(apiKey);
    const profiles: MessagingProfileSummary[] = [];
    for await (const profile of client.messagingProfiles.list()) {
      const record = profile as unknown as Record<string, unknown>;
      profiles.push({
        id: String(record.id ?? ""),
        name: typeof record.name === "string" ? record.name : null,
        whitelistedDestinations: Array.isArray(record.whitelisted_destinations)
          ? (record.whitelisted_destinations as string[])
          : null,
        alphaSender: typeof record.alpha_sender === "string" ? record.alpha_sender : null,
      });
    }
    return profiles;
  } catch (error) {
    throw toTelnyxError(error);
  }
}
