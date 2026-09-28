/**
 * Telnyx REST client.
 *
 * Hand-rolled fetch rather than the SDK, for two reasons: the send path has to
 * run in a plain worker with no Node-specific assumptions, and the only calls
 * Blaster makes are small enough that the SDK's surface is not earning its
 * weight.
 *
 * A messaging profile is attached to the sending number through the profile id
 * in the request body, which is why selection happens in `profile.ts` before
 * the call rather than being left to Telnyx to guess.
 */

const TELNYX_BASE = "https://api.telnyx.com/v2";

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

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    text: input.text,
  };
  if (input.messagingProfileId) body.messaging_profile_id = input.messagingProfileId;
  if (input.clientReference) body.client_reference = input.clientReference;

  const response = await fetch(`${TELNYX_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new TelnyxError(response.status, text.slice(0, 300));
  }

  const payload = JSON.parse(text) as { data?: Record<string, unknown> };
  const data = payload.data ?? {};
  return {
    id: String(data.id ?? ""),
    status: String(data.status ?? "unknown"),
    from: String(data.from ?? input.from),
    to: String(data.to ?? input.to),
    profileId: input.messagingProfileId,
  };
}

export interface MessagingProfileSummary {
  id: string;
  name: string | null;
  whitelistedDestinations: string[] | null;
  alphaSender: string | null;
}

export async function listMessagingProfiles(apiKey: string): Promise<MessagingProfileSummary[]> {
  const response = await fetch(`${TELNYX_BASE}/messaging_profiles`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  if (!response.ok) throw new TelnyxError(response.status, text.slice(0, 300));

  const payload = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map((profile) => ({
    id: String(profile.id ?? ""),
    name: typeof profile.name === "string" ? profile.name : null,
    whitelistedDestinations: Array.isArray(profile.whitelisted_destinations)
      ? (profile.whitelisted_destinations as string[])
      : null,
    alphaSender: typeof profile.alpha_sender === "string" ? profile.alpha_sender : null,
  }));
}
