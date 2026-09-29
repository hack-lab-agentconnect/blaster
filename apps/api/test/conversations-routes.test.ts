import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The inbox routes, through the real Hono app.
 *
 * The point of this file is the gate. Convex has no auth.config.ts, so the
 * functions behind these routes are public and the HTTP layer is the only place
 * authorisation happens. A test that only checked the happy path would pass
 * whether or not the middleware was wired, so the unauthenticated cases are
 * asserted explicitly.
 *
 * Twenty's introspection is stubbed because it is the credential check itself and
 * we hold no Twenty credentials; Convex's read is stubbed so the assertions are
 * about routing, filtering, and status codes rather than about the database.
 */

const CONVERSATIONS = [
  {
    id: "conv-1",
    phoneNumber: "+13125550001",
    blasterNumber: "+14705550199",
    latestMessageAt: 3,
    latestDirection: "inbound" as const,
    latestPreview: "is this the right number",
    messageCount: 4,
    latestMessageId: "m-4",
  },
  {
    id: "conv-2",
    phoneNumber: "+447700900123",
    blasterNumber: "+14705550199",
    latestMessageAt: 1,
    latestDirection: "outbound" as const,
    latestPreview: "quick question",
    messageCount: 1,
    latestMessageId: "m-1",
  },
];

const MESSAGES = [
  {
    id: "m-1",
    direction: "outbound" as const,
    body: "quick question",
    from: "+14705550199",
    to: "+447700900123",
    status: "delivered",
    telnyxMessageId: "t-1",
    sentAt: 1,
    media: null,
  },
];

let listArgs: Record<string, unknown> | null = null;
let messageArgs: Record<string, unknown> | null = null;
let readResult: { status: "ok"; rows: unknown[] } | { status: "not-configured" } | { status: "failed"; error: string } = {
  status: "ok",
  rows: CONVERSATIONS,
};

vi.mock("../src/lib/convex/index.ts", () => ({
  listConversations: async (args: Record<string, unknown>) => {
    listArgs = args;
    return readResult;
  },
  conversationMessages: async (id: string, limit?: number) => {
    messageArgs = { id, limit };
    return readResult;
  },
  recordInboundMessage: async () => ({ status: "stored" as const, conversationId: "c", messageId: "m" }),
  applyOutboundStatus: async () => ({ status: "applied" as const, messageId: "m", stored: "sent" }),
}));

let introspectedToken: string | null = null;
let introspectionActive = true;

vi.mock("../src/lib/twenty/oauth/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/twenty/oauth/index.ts")>();
  return {
    ...actual,
    checkOperatorToken: async (_config: unknown, token: string) => {
      introspectedToken = token;
      return { active: introspectionActive, username: "operator@example.com", scope: "api" };
    },
  };
});

let app: { fetch: (request: Request) => Promise<Response> };
const setEnv = (patch: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

beforeEach(async () => {
  listArgs = null;
  messageArgs = null;
  introspectedToken = null;
  introspectionActive = true;
  readResult = { status: "ok", rows: CONVERSATIONS };
  setEnv({
    TWENTY_BASE_URL: "https://twenty.example",
    TWENTY_OAUTH_CLIENT_ID: "client-1",
    TWENTY_OAUTH_REDIRECT_URI: "http://localhost:5173/callback",
    TWENTY_OAUTH_CLIENT_SECRET: undefined,
    CONVEX_URL: "https://deployment.convex.cloud",
  });
  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

afterEach(() => {
  vi.clearAllMocks();
  setEnv({
    TWENTY_BASE_URL: undefined,
    TWENTY_OAUTH_CLIENT_ID: undefined,
    TWENTY_OAUTH_REDIRECT_URI: undefined,
    CONVEX_URL: undefined,
  });
});

const authed = (path: string, token = "op-token") =>
  app.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }));

describe("GET /api/conversations", () => {
  test("returns the list for a live operator token", async () => {
    const response = await authed("/api/conversations");
    const body = (await response.json()) as { count: number; conversations: unknown[] };
    expect(response.status).toBe(200);
    expect(body.count).toBe(2);
    expect(introspectedToken).toBe("op-token");
  });

  test("refuses an unauthenticated caller, and never reads Convex", async () => {
    const response = await app.fetch(new Request("http://localhost/api/conversations"));
    expect(response.status).toBe(401);
    expect(listArgs).toBeNull();
  });

  test("refuses a token Twenty says is not active", async () => {
    introspectionActive = false;
    const response = await authed("/api/conversations");
    expect(response.status).toBe(401);
    expect(listArgs).toBeNull();
  });

  test("fails closed when sign-in is not configured, rather than opening the route", async () => {
    setEnv({ TWENTY_OAUTH_CLIENT_ID: undefined });
    const response = await authed("/api/conversations");
    expect(response.status).toBe(503);
    expect(listArgs).toBeNull();
  });

  test("passes the number and campaign filters through", async () => {
    await authed("/api/conversations?number=%2B1%20470%20555%200199&campaign=camp-7&limit=10");
    expect(listArgs).toMatchObject({
      number: "+1 470 555 0199",
      campaign: "camp-7",
      limit: 10,
      // Resolving the campaign costs a lookup per row, so asking for it must
      // switch it on.
      withCampaign: true,
    });
  });

  test("leaves the campaign unrequested by default", async () => {
    await authed("/api/conversations");
    expect(listArgs).toMatchObject({ withCampaign: false });
    expect(listArgs).not.toHaveProperty("campaign");
  });

  test("reports a missing Convex deployment rather than an empty inbox", async () => {
    readResult = { status: "not-configured" };
    const response = await authed("/api/conversations");
    expect(response.status).toBe(503);
  });

  test("a Convex read failure is a 502, not an empty list", async () => {
    // An empty inbox and a broken inbox look identical to a client, and the
    // difference matters to whoever is trying to work out why nothing shows up.
    readResult = { status: "failed", error: "convex unreachable" };
    const response = await authed("/api/conversations");
    expect(response.status).toBe(502);
  });
});

describe("GET /api/conversations/:id/messages", () => {
  test("returns the thread for a live operator token", async () => {
    readResult = { status: "ok", rows: MESSAGES };
    const response = await authed("/api/conversations/k171855q923bdkx00je595qmmn8fa832/messages?limit=25");
    const body = (await response.json()) as { count: number; messages: unknown[] };
    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(messageArgs).toEqual({ id: "k171855q923bdkx00je595qmmn8fa832", limit: 25 });
  });

  test("refuses an unauthenticated caller", async () => {
    const response = await app.fetch(new Request("http://localhost/api/conversations/k171855q923bdkx00je595qmmn8fa832/messages"));
    expect(response.status).toBe(401);
    expect(messageArgs).toBeNull();
  });

  test("a rejected id is a 404, not a server error", async () => {
    readResult = { status: "failed", error: "Argument 'conversationId' is invalid" };
    const response = await authed("/api/conversations/not-an-id/messages");
    expect(response.status).toBe(404);
  });

  test("a genuine backend failure stays a 502", async () => {
    readResult = { status: "failed", error: "convex unreachable" };
    const response = await authed("/api/conversations/k171855q923bdkx00je595qmmn8fa832/messages");
    expect(response.status).toBe(502);
  });
});
