import { beforeEach, describe, expect, test, vi } from "vitest";
import { TwentyClient } from "../src/twenty/client/helpers/client.ts";
import { forgetMemberName, resolveActor } from "../src/twenty/actor/index.ts";
import type { ActorPayload } from "../src/twenty/actor/index.ts";

const BASE = { baseUrl: "https://twenty.test", apiKey: "key" };

/** A member row as Twenty returns it, with `name` still a composite. */
function memberRow(id: string, first: string, last: string, email: string) {
  return { id, userId: `user-${id}`, userEmail: email, name: { firstName: first, lastName: last } };
}

function fakeClient(rows: unknown[]) {
  const listAll = vi.fn(async () => rows);
  return { client: { listAll } as unknown as TwentyClient, listAll };
}

const actorFor = (id: string, name: string): ActorPayload => ({
  source: "API",
  workspaceMemberId: id,
  name,
});

describe("resolveActor", () => {
  beforeEach(() => {
    forgetMemberName("m-1");
    forgetMemberName("m-2");
  });

  test("no member means no actor, and no lookup is attempted", async () => {
    const { client, listAll } = fakeClient([memberRow("m-1", "Ada", "L", "ada@test")]);
    expect(await resolveActor(client, { email: "ada@test" })).toBeNull();
    expect(await resolveActor(client, {})).toBeNull();
    expect(listAll).not.toHaveBeenCalled();
  });

  test("uses the member's own name from Twenty", async () => {
    const { client } = fakeClient([memberRow("m-1", "Ada", "Lovelace", "ada@test")]);
    expect(await resolveActor(client, { workspaceMemberId: "m-1" })).toEqual({
      createdBy: actorFor("m-1", "Ada Lovelace"),
    });
  });

  test("prefers the exact member id over the email when both are given", async () => {
    const { client } = fakeClient([
      memberRow("m-1", "Ada", "Lovelace", "ada@test"),
      memberRow("m-2", "Grace", "Hopper", "grace@test"),
    ]);
    const actor = await resolveActor(client, {
      workspaceMemberId: "m-1",
      email: "grace@test",
    });
    expect(actor?.createdBy?.workspaceMemberId).toBe("m-1");
    expect(actor?.createdBy?.name).toBe("Ada Lovelace");
  });

  test("a member with no name falls back to their email, then the id", async () => {
    const { client } = fakeClient([
      { id: "m-1", userId: "u", userEmail: "nameless@test", name: {} },
      { id: "m-2", userId: "u", userEmail: null, name: {} },
    ]);
    expect((await resolveActor(client, { workspaceMemberId: "m-1" }))?.createdBy?.name).toBe(
      "nameless@test",
    );
    expect((await resolveActor(client, { workspaceMemberId: "m-2" }))?.createdBy?.name).toBe("m-2");
  });

  test("a member row that no longer exists still attributes by id", async () => {
    const { client } = fakeClient([]);
    const actor = await resolveActor(client, {
      workspaceMemberId: "m-gone",
      name: "Deleted User",
    });
    expect(actor).toEqual({ createdBy: actorFor("m-gone", "Deleted User") });
  });

  test("Twenty being unreachable degrades to a name, not a failure", async () => {
    const client = {
      listAll: vi.fn(async () => {
        throw new Error("network down");
      }),
    } as unknown as TwentyClient;
    const actor = await resolveActor(client, {
      workspaceMemberId: "m-2",
      email: "grace@test",
    });
    expect(actor).toEqual({ createdBy: actorFor("m-2", "grace@test") });
  });

  test("the name is cached, so a burst of writes reads Twenty once", async () => {
    const { client, listAll } = fakeClient([memberRow("m-1", "Ada", "Lovelace", "ada@test")]);
    await resolveActor(client, { workspaceMemberId: "m-1" });
    await resolveActor(client, { workspaceMemberId: "m-1" });
    await resolveActor(client, { workspaceMemberId: "m-1" });
    expect(listAll).toHaveBeenCalledTimes(1);
  });
});

describe("the actor on a write", () => {
  const bodies: string[] = [];

  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ data: { agencyPhone: { id: "new-1" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  const body = () => JSON.parse(bodies[0] as string) as Record<string, unknown>;

  test("create carries createdBy when an actor is supplied", async () => {
    await new TwentyClient(BASE).create("agencyPhones", { phoneNumber: "+15551234567" }, {
      createdBy: actorFor("m-1", "Ada Lovelace"),
    });
    expect(body().createdBy).toEqual(actorFor("m-1", "Ada Lovelace"));
    expect(body().phoneNumber).toBe("+15551234567");
  });

  test("create without an actor is byte-for-byte what it always was", async () => {
    await new TwentyClient(BASE).create("agencyPhones", { phoneNumber: "+15551234567" });
    expect(body()).toEqual({ phoneNumber: "+15551234567" });
  });

  test("a null actor is the same as no actor", async () => {
    await new TwentyClient(BASE).create("agencyPhones", { phoneNumber: "+1" }, null);
    expect(body()).toEqual({ phoneNumber: "+1" });
  });

  test("a caller that set its own createdBy keeps it", async () => {
    await new TwentyClient(BASE).create(
      "agencyPhones",
      { phoneNumber: "+1", createdBy: { source: "API", workspaceMemberId: "explicit", name: "Explicit" } },
      { createdBy: actorFor("m-1", "Ada Lovelace") },
    );
    expect((body().createdBy as { workspaceMemberId: string }).workspaceMemberId).toBe("explicit");
  });

  test("update carries the actor too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ data: { agencyPhone: { id: "p-1" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await new TwentyClient(BASE).update("agencyPhones", "p-1", { status: "active" }, {
      createdBy: actorFor("m-1", "Ada Lovelace"),
    });
    expect(body().createdBy).toEqual(actorFor("m-1", "Ada Lovelace"));
  });
});
