/**
 * One HTTP client for the Blaster API, shared by every surface.
 *
 * Errors are normalised into `BlasterApiError` so a caller never has to know
 * that the API happens to be Hono or that the backend behind it is Convex. The
 * three adapters this replaces each invented their own error handling, which is
 * how a 503 from an unconfigured deployment becomes an empty list on one
 * surface and a crash on another.
 */

import {
  BlasterApiError,
  classifyStatus,
  type ConversationMessageRow,
  type ConversationSummary,
  type ListConversationsQuery,
  type SendRequest,
  type SentMessage,
  type SendResolution,
} from "../types.ts";

export interface BlasterApiClientOptions {
  /** Origin of the API, without a trailing path, e.g. http://localhost:4180 */
  baseUrl: string;
  /** The operator's token from `blaster login`. */
  accessToken: string;
  fetchFn?: typeof fetch;
}

export interface BlasterApiClient {
  listConversations(query?: ListConversationsQuery): Promise<ConversationSummary[]>;
  conversationMessages(conversationId: string, limit?: number): Promise<ConversationMessageRow[]>;
  /**
   * Hand a message to the provider.
   *
   * The caller names the recipient, the body, and optionally the sending number.
   * It does not name a profile: the API reads the sending number's own record
   * from Twenty, so a surface cannot send from a number against the wrong
   * registration by passing the wrong id.
   */
  sendMessage(input: SendRequest): Promise<{ sent: SentMessage; resolution: SendResolution }>;
}



const trimBase = (value: string): string => value.replace(/\/+$/, "");

export function createBlasterApiClient(options: BlasterApiClientOptions): BlasterApiClient {
  const fetchFn = options.fetchFn ?? fetch;
  const base = trimBase(options.baseUrl);

  /**
   * One request, with the operator's token and transport failures classified.
   *
   * A rejected fetch is not an `HTTPError` and carries no status, so without this
   * a caller sees an opaque `TypeError: fetch failed` and cannot tell "the server
   * is down" from "the server said no". Both surfaces branch on the kind, and a
   * retryable failure has to be distinguishable from a wrong answer, so it is
   * turned into `unavailable` here where the distinction is actually known.
   */
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchFn(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${options.accessToken}` },
      });
    } catch (error) {
      throw new BlasterApiError(
        0,
        "unavailable",
        `Could not reach the Blaster API at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const get = async <T>(path: string, params: Record<string, string | number | boolean | undefined>) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await request(url.toString(), { method: "GET" });
    if (!response.ok) {
      // The body is read for its message, but never surfaced verbatim: it is a
      // provider's words on a surface the caller did not write.
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new BlasterApiError(
        response.status,
        classifyStatus(response.status),
        detail?.error ?? `The Blaster API answered ${response.status}`,
      );
    }
    return (await response.json()) as T;
  };

  // A send is a POST with a body, so it does not share `get`. The status
  // classification and the "never surface a provider body verbatim" rule are
  // the same, because a caller must be able to branch on the failure the same
  // way whichever way it was made.
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new BlasterApiError(
        response.status,
        classifyStatus(response.status),
        detail?.error ?? `The Blaster API answered ${response.status}`,
      );
    }
    return (await response.json()) as T;
  };

  return {
    async listConversations(query = {}) {
      const body = await get<{ conversations: ConversationSummary[] }>("/api/conversations", {
        limit: query.limit,
        number: query.number,
        campaign: query.campaign,
        withCampaign: query.withCampaign,
      });
      return body.conversations;
    },

    async conversationMessages(conversationId, limit) {
      const body = await get<{ messages: ConversationMessageRow[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { limit },
      );
      return body.messages;
    },

    sendMessage(input) {
      return post<{ sent: SentMessage; resolution: SendResolution }>("/api/messages/send", {
        to: input.to,
        text: input.text,
        ...(input.from === undefined ? {} : { from: input.from }),
      });
    },
  };
}
