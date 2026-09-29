/**
 * The generated Twenty client, actually running.
 *
 * This is the load-bearing test for `twenty/api`: it imports the client that
 * `pnpm twenty:client` emitted from the live workspace, binds it through the
 * session factory, and proves three things that unit tests with a hand-written
 * stub cannot:
 *
 *   1. the workspace's own `agency*` custom objects resolve into real GraphQL,
 *   2. the operator's OAuth token is attached to that generated request, and
 *   3. when the instance rejects the token, the refresh-and-replay path in
 *      twenty/api recovers the call rather than surfacing a stale-token error.
 *
 * Everything is stubbed at the fetch boundary, so no credentials and no
 * workspace are needed.
 */
import { describe, expect, test } from "vitest";
import { createClient } from "../src/twenty/api/generated/index.ts";
import { createTwentyClient } from "../src/twenty/api/helpers/client.ts";
import { createServerTwentyClient } from "../src/twenty/api/helpers/server-client.ts";
import type { SessionStore, TwentySession } from "../src/twenty/api/types.ts";

const SESSION: TwentySession = {
  tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, scope: "api" },
  obtainedAtMs: 1_000_000,
};

function memoryStore(session: TwentySession | null = SESSION): SessionStore & { saved: TwentySession[] } {
  let current = session;
  const saved: TwentySession[] = [];
  return {
    saved,
    load: () => current,
    save: (next) => {
      current = next;
      saved.push(next);
    },
    clear: () => {
      current = null;
    },
  };
}

interface Recorded {
  authorization: string | null;
  body: { query: string; variables: Record<string, unknown> };
}

function recorder(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    calls.push({
      authorization: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)) as Recorded["body"],
    });
    const next = responses.shift() ?? { body: { data: {} } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const bind = (store: SessionStore, fetchFn: typeof fetch, nowMs = 1_000_000) =>
  createTwentyClient({
    graphqlUrl: "https://twenty.example/graphql",
    createClient,
    loadSession: store.load,
    saveSession: store.save,
    clearSession: store.clear,
    refreshTokens: async () => ({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresIn: 3600,
      scope: "api",
    }),
    fetchFn,
    nowMs,
  });

describe("generated Twenty client", () => {
  test("turns an agencyPhones selection into the workspace's own GraphQL", async () => {
    const store = memoryStore();
    const { calls, fetchFn } = recorder([
      {
        body: {
          data: {
            agencyPhones: {
              totalCount: 1,
              edges: [
                {
                  node: {
                    id: "phone-1",
                    phoneNumber: "+15551234567",
                    state: "AVAILABLE",
                    messagingProfileId: null,
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    const client = bind(store, fetchFn);
    const result = await client.query({
      agencyPhones: {
        __args: { first: 1 },
        edges: {
          node: { id: true, phoneNumber: true, state: true, messagingProfileId: true },
        },
        totalCount: true,
      },
    });

    expect(calls).toHaveLength(1);
    const { query, variables } = calls[0]!.body;
    // Arguments become GraphQL variables, not string-built values, so the
    // generated document is cacheable and injection-free.
    expect(query).toBe(
      "query ($v1:Int){agencyPhones(first:$v1){edges{node{id,phoneNumber,state,messagingProfileId}},totalCount}}",
    );
    expect(variables).toEqual({ v1: 1 });
    // The operator's token, not the server's API key: this client is the one
    // an authenticated browser or CLI holds.
    expect(calls[0]!.authorization).toBe("Bearer at-1");
    expect(result.agencyPhones!.edges[0]!.node.phoneNumber).toBe("+15551234567");
  });

  test("reads agencyLeads and agencyCalls from the same typed client", async () => {
    const { calls, fetchFn } = recorder([
      { body: { data: { agencyLeads: { totalCount: 0, edges: [] } } } },
      { body: { data: { agencyCalls: { totalCount: 0, edges: [] } } } },
    ]);
    const client = bind(memoryStore(), fetchFn);

    await client.query({
      agencyLeads: { __args: { first: 1 }, totalCount: true, edges: { node: { id: true } } },
    });
    await client.query({
      agencyCalls: { __args: { first: 1 }, totalCount: true, edges: { node: { id: true } } },
    });

    expect(calls[0]!.body.query).toContain("agencyLeads(first:$v1)");
    expect(calls[1]!.body.query).toContain("agencyCalls(first:$v1)");
  });

  test("refreshes the token and replays the generated query once", async () => {
    const store = memoryStore();
    const { calls, fetchFn } = recorder([
      { body: { errors: [{ message: "expired", extensions: { code: "UNAUTHENTICATED" } }] } },
      { body: { data: { agencyPhones: { totalCount: 2, edges: [] } } } },
    ]);

    const client = bind(store, fetchFn);
    const result = await client.query({
      agencyPhones: { __args: { first: 1 }, totalCount: true, edges: { node: { id: true } } },
    });

    expect(calls.map((call) => call.authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);
    // The replay must be the same document, not a degraded one.
    expect(calls[1]!.body.query).toBe(calls[0]!.body.query);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.tokens.accessToken).toBe("at-2");
    expect(result.agencyPhones!.totalCount).toBe(2);
  });

  test("surfaces a real GraphQL error when the instance rejects the query", async () => {
    const { fetchFn } = recorder([
      { body: { errors: [{ message: "Cannot query field nope" }], data: null } },
    ]);
    const client = bind(memoryStore(), fetchFn);
    await expect(
      client.query({ __name: "Nope", agencyPhones: { __args: { first: 1 }, totalCount: true } }),
    ).rejects.toThrow();
  });
});

describe("server-bound Twenty client", () => {
  test("authenticates as the workspace with the bearer key, never basic auth", async () => {
    const seen: Array<{ url: string; authorization: string | null; query: string }> = [];
    const client = createServerTwentyClient({
      baseUrl: "https://twenty.example/",
      apiKey: "workspace-key",
      // Declared but deliberately not applied: the guard exempts /graphql, and
      // both credentials are the same header.
      basicAuth: { user: "twenty", password: "guard" },
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("Authorization"),
          query: JSON.parse(String(init?.body)).query as string,
        });
        return new Response(JSON.stringify({ data: { agencyPhones: { totalCount: 3, edges: [] } } }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await client.query({
      agencyPhones: { __args: { first: 1 }, totalCount: true, edges: { node: { id: true } } },
    });

    expect(seen[0]!.url).toBe("https://twenty.example/graphql");
    expect(seen[0]!.authorization).toBe("Bearer workspace-key");
    expect(seen[0]!.query).toContain("agencyPhones");
    expect(result.agencyPhones!.totalCount).toBe(3);
  });

  test("refuses to build without the workspace key", () => {
    expect(() => createServerTwentyClient({ baseUrl: "https://twenty.example", apiKey: "" })).toThrow(
      /TWENTY_BASE_URL and TWENTY_API_KEY/,
    );
  });
});
