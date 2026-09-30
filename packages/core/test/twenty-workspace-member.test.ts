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

  test("resolves by userId, the column a member row carries", async () => {
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
  // The claims a user-authorized Twenty access token carries. `sub` is the
  // application id and is present to prove it is never used for identity.
  const USER_TOKEN = { sub: "app-42", userId: "u-1", userWorkspaceId: "m-1" };

  beforeEach(() => {
    forgetResolvedMember("m-1");
    forgetResolvedMember("u-1");
    forgetResolvedMember("u-missing");
  });

  test("userWorkspaceId resolves the member it names", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, { claims: USER_TOKEN });
    expect(resolved).toMatchObject({ workspaceMemberId: "m-1", resolvedVia: "jwt:userWorkspaceId" });
  });

  test("userId resolves when there is no userWorkspaceId", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, { claims: { userId: "u-2" } });
    expect(resolved).toMatchObject({ workspaceMemberId: "m-2", resolvedVia: "jwt:userId" });
  });

  test("userWorkspaceId wins over userId when both are present", async () => {
    // The rows disagree: m-1 belongs to u-1, u-2 belongs to m-2. The stronger
    // claim must win rather than the one that happens to be checked first.
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      claims: { userWorkspaceId: "m-1", userId: "u-2" },
    });
    expect(resolved?.workspaceMemberId).toBe("m-1");
    expect(resolved?.resolvedVia).toBe("jwt:userWorkspaceId");
  });

  test("the application id in sub is never used as a user id", async () => {
    // This is the bug PR 11 fixed in the dialer, and the test that would have
    // caught it here: `sub` is the application id, so resolving by it matches
    // no member and every record goes unattributed.
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      claims: { sub: "app-42" },
    });
    expect(resolved).toBeNull();
  });

  test("an application token with placeholder claims resolves to nobody", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      claims: { sub: "app-42", userId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(resolved).toBeNull();
  });

  test("an email claim is the compatibility fallback", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      introspectionClaims: { email: "grace@example.com", scope: "api profile" },
    });
    expect(resolved).toMatchObject({ workspaceMemberId: "m-2", resolvedVia: "claim:email" });
  });

  test("a claim whose value merely looks email-ish is used, because the field name varies", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      introspectionClaims: { someUndocumentedField: "ada@example.com" },
    });
    expect(resolved?.workspaceMemberId).toBe("m-1");
  });

  test("the jwt claims are preferred over an email claim", async () => {
    const resolved = await resolveMemberIdentity(fakeClient().client, {
      claims: { userId: "u-2" },
      introspectionClaims: { email: "ada@example.com" },
    });
    expect(resolved?.workspaceMemberId).toBe("m-2");
  });

  test("no claims and no email means nothing to resolve, without reading", async () => {
    const { client, listAll } = fakeClient();
    expect(await resolveMemberIdentity(client, {})).toBeNull();
    expect(await resolveMemberIdentity(client, { claims: null, introspectionClaims: {} })).toBeNull();
    expect(listAll).not.toHaveBeenCalled();
  });

  test("an unknown userId resolves to null, which callers read as unattributed", async () => {
    expect(
      await resolveMemberIdentity(fakeClient().client, { claims: { userId: "u-missing" } }),
    ).toBeNull();
  });

  test("Twenty being unreachable degrades to null instead of failing the request", async () => {
    const client = {
      listAll: vi.fn(async () => {
        throw new Error("503 from Twenty");
      }),
    } as unknown as TwentyClient;
    expect(await resolveMemberIdentity(client, { claims: USER_TOKEN })).toBeNull();
  });

  test("the resolution is cached across requests", async () => {
    const { client, listAll } = fakeClient();
    await resolveMemberIdentity(client, { claims: USER_TOKEN });
    await resolveMemberIdentity(client, { claims: USER_TOKEN });
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  test("forgetting a resolution forces the next request to ask again", async () => {
    const { client, listAll } = fakeClient();
    await resolveMemberIdentity(client, { claims: USER_TOKEN });
    forgetResolvedMember("m-1");
    await resolveMemberIdentity(client, { claims: USER_TOKEN });
    expect(listAll).toHaveBeenCalledTimes(2);
  });
});
