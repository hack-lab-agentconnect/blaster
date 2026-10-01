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
  type AddPoolNumberInput,
  type BatchSendResult,
  type ConversationMessageRow,
  type ConversationSummary,
  type CreatePoolInput,
  type ListConversationsQuery,
  type PoolDetail,
  type PoolSummary,
  type ProspectField,
  type ProspectFilter,
  type ProspectSelection,
  type RemovePoolNumberInput,
  type ReorderPoolNumbersInput,
  type SendingNumber,
  type SendPreview,
  type SendRequest,
  type SentMessage,
  type SendResolution,
  type SequenceOption,
  type SetSequencePoolInput,
  type SuppressionRow,
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
   * The workspace's sendable numbers, for a sender selector.
   *
   * The returned ids are the authority later calls pass back: the server
   * re-resolves each one to its Twenty row, so the client never supplies a
   * number or a profile of its own.
   */
  listSendingNumbers(): Promise<SendingNumber[]>;
  /** The filterable prospect menu the guided send renders. */
  listProspectFields(): Promise<ProspectField[]>;
  /** One page of prospects matching caller-supplied filter definitions. */
  searchProspects(input: { filters: ProspectFilter[]; cursor?: string | null; limit?: number }): Promise<ProspectSelection>;
  /** What a batch would do, without sending anything. */
  previewProspectSend(input: { agencyPhoneId: string; filters: ProspectFilter[]; text: string }): Promise<SendPreview>;
  /** Send to every eligible prospect matching the filters. */
  sendToProspects(input: {
    agencyPhoneId: string;
    filters: ProspectFilter[];
    text: string;
    idempotencyKey: string;
  }): Promise<BatchSendResult>;
  /**
   * Hand a message to the provider.
   *
   * The caller names the recipient, the body, and optionally the sending number.
   * It does not name a profile: the API reads the sending number's own record
   * from Twenty, so a surface cannot send from a number against the wrong
   * registration by passing the wrong id.
   */
  sendMessage(input: SendRequest): Promise<{ sent: SentMessage; resolution: SendResolution }>;

  /** The pools this deployment works from. */
  listPools(): Promise<PoolSummary[]>;
  /** One pool with its memberships in order. */
  getPool(poolId: string): Promise<PoolDetail | null>;
  createPool(input: CreatePoolInput): Promise<{ id: string }>;
  /** Add a number to a pool, or reactivate a removed one. */
  addPoolNumber(input: AddPoolNumberInput): Promise<PoolDetail>;
  /** Remove a number from a pool. Soft: the membership is kept as `removed`. */
  removePoolNumber(input: RemovePoolNumberInput): Promise<PoolDetail>;
  /** Set the order a pool works its numbers in. */
  reorderPoolNumbers(input: ReorderPoolNumbersInput): Promise<PoolDetail>;
  /** Assign a pool to a sequence, or clear it. */
  setSequencePool(input: SetSequencePoolInput): Promise<{ sequenceId: string }>;
  /** Sequences, for a pool-assignment picker. */
  listSequences(): Promise<SequenceOption[]>;

  /** Everyone currently suppressed (a durable per-person do-not-contact). */
  listSuppressions(): Promise<SuppressionRow[]>;
  /** Suppress a peer, or lift a suppression. */
  setSuppression(input: { peer: string; suppressed: boolean; reason?: string }): Promise<{ peer: string; changed: boolean }>;
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

  // POST covers most writes; pools also need PUT and DELETE for reorder and
  // removal. The error classification is identical, so it is shared here rather
  // than reimplemented per method.
  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await request(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
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

    async listSendingNumbers() {
      const body = await get<{ phones: SendingNumber[] }>("/api/agency-phones", {});
      return body.phones;
    },

    /**
     * The filterable prospect menu, then pages, previews, and batch sends
     * against it. Filters travel to the server as definitions; the server
     * validates them against its menu and queries Twenty, so a client never
     * submits query DSL of its own and never fetches recipient lists as the
     * authority for who gets messaged.
     */
    async listProspectFields() {
      const body = await get<{ fields: ProspectField[] }>("/api/prospects/fields", {});
      return body.fields;
    },

    async searchProspects(input: { filters: ProspectFilter[]; cursor?: string | null; limit?: number }) {
      return post<ProspectSelection>("/api/prospects/search", {
        filters: input.filters,
        ...(input.cursor === undefined || input.cursor === null ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },

    async previewProspectSend(input: { agencyPhoneId: string; filters: ProspectFilter[]; text: string }) {
      return post<SendPreview>("/api/messages/preview", input);
    },

    async sendToProspects(input: {
      agencyPhoneId: string;
      filters: ProspectFilter[];
      text: string;
      idempotencyKey: string;
    }) {
      return post<BatchSendResult>("/api/messages/batch-send", input);
    },

    /**
     * Pools and their memberships.
     *
     * Removing a number is a soft removal: the API keeps the membership as
     * `removed`, so an in-flight send still resolves and the history survives.
     * A pool assigned to a sequence supplies the sending number at send time in
     * pool order and within each number's rate budget.
     */
    async listPools() {
      const body = await get<{ pools: PoolSummary[] }>("/api/pools", {});
      return body.pools;
    },

    getPool(poolId) {
      return get<PoolDetail | null>(`/api/pools/${encodeURIComponent(poolId)}`, {});
    },

    createPool(input) {
      return post<{ id: string }>("/api/pools", input);
    },

    addPoolNumber(input) {
      return post<PoolDetail>(`/api/pools/${encodeURIComponent(input.poolId)}/numbers`, {
        phoneNumber: input.phoneNumber,
        ...(input.order === undefined ? {} : { order: input.order }),
      });
    },

    removePoolNumber(input) {
      return send<PoolDetail>(
        "DELETE",
        `/api/pools/${encodeURIComponent(input.poolId)}/numbers/${encodeURIComponent(input.phoneNumber)}`,
      );
    },

    reorderPoolNumbers(input) {
      return send<PoolDetail>("PUT", `/api/pools/${encodeURIComponent(input.poolId)}/numbers`, {
        order: input.order,
      });
    },

    setSequencePool(input) {
      return post<{ sequenceId: string }>(
        `/api/sequences/${encodeURIComponent(input.sequenceId)}/pool`,
        input.poolId === undefined ? {} : { poolId: input.poolId },
      );
    },

    async listSequences() {
      const body = await get<{ sequences: SequenceOption[] }>("/api/sequences", {});
      return body.sequences;
    },

    async listSuppressions() {
      const body = await get<{ suppressions: SuppressionRow[] }>("/api/suppressions", {});
      return body.suppressions;
    },

    setSuppression(input) {
      return post<{ peer: string; changed: boolean }>("/api/suppressions", {
        peer: input.peer,
        suppressed: input.suppressed,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    },
  };
}
