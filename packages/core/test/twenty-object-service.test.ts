/**
 * Twenty's object metadata (`twenty/objectService`).
 *
 * Two things are pinned here. The pure parsing, because a metadata envelope
 * change must read as "we learned nothing" rather than crash a route. And the
 * transport, because this module exists *because* the transport is different:
 * object metadata is served from `/metadata` and rejects the workspace API key,
 * which is the mistake the old `TwentyClient.hasObject` made by asking
 * `/graphql` for a field the root Query does not have.
 */

import { describe, expect, test, vi } from "vitest";
import {
  hasObject,
  listObjects,
  parseObjects,
  TwentyMetadataError,
} from "../src/twenty/objectService/index.ts";

const edge = (node: Record<string, unknown>) => ({ node });

describe("parseObjects", () => {
  test("reads nameSingular and namePlural from the metadata envelope", () => {
    const objects = parseObjects({
      objects: {
        edges: [
          edge({ id: "1", nameSingular: "agencyPhone", namePlural: "agencyPhones" }),
          edge({ nameSingular: "agencyProspect", namePlural: "agencyProspects" }),
        ],
      },
    });
    expect(objects).toEqual([
      { nameSingular: "agencyPhone", namePlural: "agencyPhones", id: "1" },
      { nameSingular: "agencyProspect", namePlural: "agencyProspects" },
    ]);
  });

  test("an unrecognised shape reads as an empty list rather than throwing", () => {
    expect(parseObjects(null)).toEqual([]);
    expect(parseObjects({})).toEqual([]);
    expect(parseObjects({ objects: {} })).toEqual([]);
    expect(parseObjects({ objects: { edges: [{}, { node: null }] } })).toEqual([]);
  });

  test("skips a node missing either spelling, since a mirror needs both", () => {
    expect(
      parseObjects({ objects: { edges: [edge({ nameSingular: "onlySingular" })] } }),
    ).toEqual([]);
  });
});

describe("hasObject", () => {
  const objects = [
    { nameSingular: "agencyPhone", namePlural: "agencyPhones" },
    { nameSingular: "person", namePlural: "people" },
  ];

  test("matches the singular a mirrored module is named after", () => {
    expect(hasObject(objects, "agencyPhone")).toBe(true);
  });

  test("also matches the plural, so a caller holding one does not have to convert", () => {
    expect(hasObject(objects, "agencyPhones")).toBe(true);
  });

  test("reports an absent object as absent", () => {
    expect(hasObject(objects, "agencyCall")).toBe(false);
  });
});

describe("listObjects", () => {
  const options = { baseUrl: "https://twenty.example", token: "operator-token" };

  test("posts to /metadata with the OAuth bearer, not the API key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { objects: { edges: [edge({ nameSingular: "person", namePlural: "people" })] } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const objects = await listObjects(options);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://twenty.example/metadata");
    // The endpoint answers "Missing authentication token" for an API key, so
    // the bearer here is the whole credential.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer operator-token");
    expect(objects).toEqual([{ nameSingular: "person", namePlural: "people" }]);
  });

  test("throws with the status on 401, so an unchecked caller cannot read it as 'no objects'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Missing authentication token", { status: 401 })),
    );
    const error = await listObjects(options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwentyMetadataError);
    expect((error as TwentyMetadataError).status).toBe(401);
  });

  test("throws when the endpoint reports GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })),
    );
    const error = await listObjects(options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwentyMetadataError);
    expect((error as TwentyMetadataError).status).toBe(422);
  });
});
