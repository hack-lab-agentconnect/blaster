import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TwentyClient } from "../src/twenty/client/helpers/client.ts";
import {
  findWorkspaceMember,
  forgetResolvedMember,
  listWorkspaceMembers,
  resolveMemberIdentity,
} from "../src/twenty/workspaceMember/index.ts";

const ROWS = [
  { id: "m-1", userId: "u-1", userEmail: "Ada@Example.com", name: { firstName: "Ada", lastName: "Lovelace" } },
  { id: "m-2", userId: "u-2", userEmail: "grace@example.com", name: { firstName: "Grace", lastName: "Hopper" } },
];

function fakeClient(rows: unknown[] = ROWS) {
  const listAll = vi.fn(async () => rows);
  return { client: { listAll } as unknown as TwentyClient, listAll };
}

describe("listWorkspaceMembers", () => {
  test("flattens the name composite and keeps the raw one", async () => {
    const [member] = await listWorkspaceMembers(fakeClient().client);
    expect(member).toMatchObject({
      id: "m-1",
      userId: "u-1",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(member?.name).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  test("a row with no composite name becomes two nulls, not a crash", async () => {
    const [member] = await listWorkspaceMembers(fakeClient([{ id: "m-9", userId: "u-9" }]).client);
    expect(member?.firstName).toBeNull();
    expect(member?.lastName).toBeNull();
  });
});

describe("findWorkspaceMember", () => {
  test("resolves by the exact member id", async () => {
    const member = await findWorkspaceMember(fakeClient().client, { workspaceMemberId: "m-2" });
    expect(member?.userEmail).toBe("grace@example.com");
  });

  test("resolves by the OAuth subject, which is a user id", async () => {
    const member = await findWorkspaceMember(fakeClient().client, { userId: "u-2" });
    expect(member?.id).toBe("m-2");
  });

  test("matches email case-insensitively", async () => {
    const member = await findWorkspaceMember(fakeClient().client, { email: "ada@example.COM" });
    expect(member?.id).toBe("m-1");
  });

  test("the strongest identifier present wins", async () => {
    const member = await findWorkspaceMember(fakeClient().client, {
      workspaceMemberId: "m-1",
      userId: "u-2",
      email: "grace@example.com",
    });
    expect(member?.id).toBe("m-1");
  });

  test("falls through to a weaker identifier when the stronger one misses", async () => {
    const member = await findWorkspaceMember(fakeClient().client, {
      workspaceMemberId: "m-missing",
      email: "grace@example.com",
    });
    expect(member?.id).toBe("m-2");
  });

  test("an identity with nothing to match on resolves to null without reading", async () => {
    const { client, listAll } = fakeClient();
    expect(await findWorkspaceMember(client, {})).toBeNull();
    expect(await findWorkspaceMember(client, { email: "  " })).toBeNull();
    expect(listAll).not.toHaveBeenCalled();
  });

  test("no match is null rather than an error", async () => {
    expect(await findWorkspaceMember(fakeClient().client, { email: "nobody@example.com" })).toBeNull();
  });
});

describe("resolveMemberIdentity", () => {
  beforeEach(() => {
    forgetResolvedMember("u-1");
    forgetResolvedMember("u-missing");
  });

  test("resolves a token subject to a member", async () => {
    // The OAuth `sub` is Twenty's userId, which is what a member row carries.
    const resolved = await resolveMemberIdentity(fakeClient().client, { sub: "u-1" });
    expect(resolved).toMatchObject({ workspaceMemberId: "m-1", userId: "u-1" });
  });

  test("no sub and no email means nothing to resolve", async () => {
    const { client, listAll } = fakeClient();
    expect(await resolveMemberIdentity(client, {})).toBeNull();
    expect(listAll).not.toHaveBeenCalled();
  });

  test("an unknown subject resolves to null, which callers read as unattributed", async () => {
    expect(await resolveMemberIdentity(fakeClient().client, { sub: "u-missing" })).toBeNull();
  });

  test("Twenty being unreachable degrades to null instead of failing the request", async () => {
    const client = {
      listAll: vi.fn(async () => {
        throw new Error("503 from Twenty");
      }),
    } as unknown as TwentyClient;
    expect(await resolveMemberIdentity(client, { sub: "u-1" })).toBeNull();
  });

  test("the sub to member mapping is cached across requests", async () => {
    const { client, listAll } = fakeClient();
    await resolveMemberIdentity(client, { sub: "u-1" });
    await resolveMemberIdentity(client, { sub: "u-1" });
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  test("forgetting a resolution forces the next request to ask again", async () => {
    const { client, listAll } = fakeClient();
    await resolveMemberIdentity(client, { sub: "u-1" });
    forgetResolvedMember("u-1");
    await resolveMemberIdentity(client, { sub: "u-1" });
    expect(listAll).toHaveBeenCalledTimes(2);
  });
});
