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
}

const trimBase = (value: string): string => value.replace(/\/+$/, "");

export function createBlasterApiClient(options: BlasterApiClientOptions): BlasterApiClient {
  const fetchFn = options.fetchFn ?? fetch;
  const base = trimBase(options.baseUrl);

  const get = async <T>(path: string, params: Record<string, string | number | boolean | undefined>) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${options.accessToken}` },
    });
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
  };
}
