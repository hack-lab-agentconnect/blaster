/**
 * Pure parsing for Twenty's object metadata. No I/O: the network call lives in
 * the module's index.ts, per the helpers-are-pure rule.
 */

import type { TwentyObjectSummary } from "../types.ts";

interface RawMetadata {
  objects?: { edges?: Array<{ node?: Record<string, unknown> }> };
}

/**
 * Read the object list out of a metadata response.
 *
 * Twenty's envelope is walked defensively: a shape change reads as an empty
 * list rather than a crash, because "we learned nothing about the workspace" is
 * a safer answer than a route that cannot start.
 */
export function parseObjects(payload: unknown): TwentyObjectSummary[] {
  const edges = (payload as RawMetadata | null)?.objects?.edges;
  if (!Array.isArray(edges)) return [];
  const objects: TwentyObjectSummary[] = [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const nameSingular = typeof node["nameSingular"] === "string" ? (node["nameSingular"] as string) : null;
    const namePlural = typeof node["namePlural"] === "string" ? (node["namePlural"] as string) : null;
    if (!nameSingular || !namePlural) continue;
    const id = typeof node["id"] === "string" ? (node["id"] as string) : undefined;
    objects.push(id === undefined ? { nameSingular, namePlural } : { nameSingular, namePlural, id });
  }
  return objects;
}

/**
 * Whether a workspace has an object, matching either spelling.
 *
 * Callers name `nameSingular` because that is what a mirrored module is named
 * after, but a caller that has only a plural is still asking a real question,
 * so both are accepted rather than making the caller convert.
 */
export function hasObject(objects: readonly TwentyObjectSummary[], name: string): boolean {
  return objects.some(
    (object) => object.nameSingular === name || object.namePlural === name,
  );
}
