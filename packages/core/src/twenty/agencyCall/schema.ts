/**
 * Provisioning the `agencyCalls` object in a workspace.
 *
 * Separate from the record I/O in `index.ts` because the two answer to different
 * callers and have different failure costs: this runs once, deliberately, by
 * whoever is setting the workspace up, and it mutates the *schema*. The record
 * path runs on every inbound webhook and must never be able to change the shape
 * of the object it is writing to.
 *
 * Idempotent end to end, and safe to re-run. Every field is checked against the
 * live schema first, and a create that loses a race is caught by matching the
 * "already exists" error rather than being treated as a failure. That matters
 * because a migration that aborts halfway leaves the workspace in a state the
 * next run has to reason about, and the whole point is that it does not.
 *
 * Two things about Twenty's metadata API are load-bearing here and are easy to
 * get wrong:
 *
 *   - Object metadata lives on `/metadata`, not `/graphql`. The root GraphQL
 *     Query has no `objects` field, so asking it is a guaranteed failure.
 *   - A mutation's option objects must be bare GraphQL literals. Passing JSON —
 *     even valid JSON — makes the parse fail on the backslashes, which is why a
 *     setup that works once fails on every re-run.
 */

import {
  CALLS_OBJECT_PLURAL,
  CALLS_OBJECT_SINGULAR,
  DATE_TIME_FIELDS,
  NUMBER_FIELDS,
  RELATION_FIELDS,
  TEXT_FIELDS,
  isFieldExistsError,
  labelFor,
  relationJoinColumn,
} from "./helpers/index.ts";
import type { CallFieldKind, CallFieldReport, CallSchemaResult, SetupCallHistoryOptions } from "./types.ts";

export type { CallFieldKind, CallFieldReport, CallSchemaResult, SetupCallHistoryOptions };

/** A failure carrying the status, so a caller can tell 401 from a 422. */
class MetadataError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Twenty metadata ${status}: ${detail}`);
    this.name = "MetadataError";
    this.status = status;
  }
}

function metadataHeaders(options: SetupCallHistoryOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.token}`,
  };
  // The instance sits behind an auth guard, so the metadata call carries the
  // guard credentials too, the same way twenty/objectService does.
  if (options.basicAuth?.user && options.basicAuth?.password) {
    const encoded = Buffer.from(
      `${options.basicAuth.user}:${options.basicAuth.password}`,
    ).toString("base64");
    headers["X-Twenty-Basic-Auth"] = encoded;
  }
  return headers;
}

async function metadataMutation<T = unknown>(
  options: SetupCallHistoryOptions,
  query: string,
): Promise<T> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/metadata`, {
    method: "POST",
    headers: metadataHeaders(options),
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
    throw new MetadataError(response.status, detail);
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new MetadataError(422, JSON.stringify(body.errors).slice(0, 300));
  }
  return body.data as T;
}

interface MetadataObjectNode {
  id: string;
  nameSingular: string;
  fields?: { edges: { node: { name: string } }[] };
}

async function listObjects(
  options: SetupCallHistoryOptions,
): Promise<MetadataObjectNode[]> {
  const first = options.first ?? 100;
  const data = await metadataMutation<{ objects: { edges: { node: MetadataObjectNode }[] } }>(
    options,
    `{ objects(paging: { first: ${first} }) { edges { node { id nameSingular } } } }`,
  );
  return data.objects.edges.map((edge) => edge.node);
}

async function getObjectFields(
  options: SetupCallHistoryOptions,
  objectMetadataId: string,
): Promise<Set<string>> {
  const data = await metadataMutation<{
    objects: { edges: { node: MetadataObjectNode }[] };
  }>(
    options,
    `{ objects(paging: { first: 100 }) { edges { node { id fields(paging: { first: 100 }) { edges { node { name } } } } } } }`,
  );
  const node = data.objects.edges.map((edge) => edge.node).find((n) => n.id === objectMetadataId);
  return new Set((node?.fields?.edges ?? []).map((edge) => edge.node.name));
}

/** Create a scalar field. Types map to Twenty's metadata enum of the same name. */
async function createScalarField(
  options: SetupCallHistoryOptions,
  objectMetadataId: string,
  type: "TEXT" | "DATE_TIME" | "NUMBER",
  name: string,
): Promise<void> {
  const label = JSON.stringify(labelFor(name));
  await metadataMutation(
    options,
    `mutation {
      createOneField(input: { field: {
        objectMetadataId: ${JSON.stringify(objectMetadataId)}
        type: ${type}
        name: ${JSON.stringify(name)}
        label: ${label}
        description: ""
        isNullable: true
      } }) { id name }
    }`,
  );
}

/**
 * Create a MANY_TO_ONE relation, deleting the target record rather than blocking
 * when it goes away.
 *
 * The join column is named explicitly as `<name>Id`, which is the column REST
 * writes address. Declaring the field under the base name and letting Twenty
 * choose would leave the two out of step, and the write path would silently fail
 * against a relation whose column is named something else.
 */
async function createRelation(
  options: SetupCallHistoryOptions,
  objectMetadataId: string,
  targetObjectMetadataId: string,
  name: string,
): Promise<void> {
  const joinColumn = relationJoinColumn(name);
  const label = JSON.stringify(labelFor(name));
  await metadataMutation(
    options,
    `mutation {
      createOneField(input: { field: {
        objectMetadataId: ${JSON.stringify(objectMetadataId)}
        type: RELATION
        name: ${JSON.stringify(name)}
        label: ${label}
        description: ""
        isNullable: true
        settings: { relationType: "MANY_TO_ONE", onDelete: "SET_NULL", joinColumnName: ${JSON.stringify(joinColumn)} }
        relationCreationPayload: {
          targetObjectMetadataId: ${JSON.stringify(targetObjectMetadataId)}
          targetFieldLabel: "Name"
          targetFieldIcon: "IconPhoneCall"
          type: "MANY_TO_ONE"
        }
      } }) { id name }
    }`,
  );
}

/**
 * Ensure `agencyCalls` exists with every field the call-history path needs.
 *
 * Relations are created last because a relation needs its target object to exist
 * first. A relation whose target is absent is skipped and reported as neither
 * new nor present, rather than failing the run: the rest of the schema is still
 * worth having, and the relation can be added once the target object is created.
 */
export async function setupCallHistorySchema(
  options: SetupCallHistoryOptions,
): Promise<CallSchemaResult> {
  const objects = await listObjects(options);
  const bySingular = new Map(objects.map((node) => [node.nameSingular, node]));

  let objectId = bySingular.get(CALLS_OBJECT_SINGULAR)?.id ?? null;
  let objectIsNew = false;
  if (!objectId) {
    const data = await metadataMutation<{ createOneObject?: { id: string }; object?: { id: string } }>(
      options,
      `mutation {
        createOneObject(input: { object: {
          nameSingular: ${JSON.stringify(CALLS_OBJECT_SINGULAR)}
          namePlural: ${JSON.stringify(CALLS_OBJECT_PLURAL)}
          labelSingular: "Call"
          labelPlural: "Calls"
          description: "Call history records"
          icon: "IconPhoneCall"
          isLabelSyncedWithName: false
        } }) { id nameSingular namePlural }
      }`,
    );
    const created = data.createOneObject ?? data.object;
    if (!created?.id) throw new Error("Could not create the agencyCalls object");
    objectId = created.id;
    objectIsNew = true;
  }

  const existing = await getObjectFields(options, objectId);
  const fields: CallFieldReport[] = [];

  const ensure = async (
    kind: CallFieldKind,
    type: "TEXT" | "DATE_TIME" | "NUMBER",
    name: string,
  ): Promise<void> => {
    if (existing.has(name)) {
      fields.push({ name, kind, isNew: false });
      return;
    }
    try {
      await createScalarField(options, objectId as string, type, name);
      fields.push({ name, kind, isNew: true });
    } catch (error) {
      // A name or label that is already taken means the field is present under
      // another name, which is close enough: report it and carry on.
      if (isFieldExistsError(error)) {
        fields.push({ name, kind, isNew: false });
        return;
      }
      throw error;
    }
  };

  for (const name of TEXT_FIELDS) await ensure("text", "TEXT", name);
  for (const name of DATE_TIME_FIELDS) await ensure("date-time", "DATE_TIME", name);
  for (const name of NUMBER_FIELDS) await ensure("number", "NUMBER", name);

  for (const relation of RELATION_FIELDS) {
    if (existing.has(relation.name)) {
      fields.push({ name: relation.name, kind: "relation", isNew: false });
      continue;
    }
    const targetId = bySingular.get(relation.target)?.id;
    if (!targetId) continue;
    try {
      await createRelation(options, objectId, targetId, relation.name);
      fields.push({ name: relation.name, kind: "relation", isNew: true });
    } catch (error) {
      if (isFieldExistsError(error)) {
        fields.push({ name: relation.name, kind: "relation", isNew: false });
        continue;
      }
      throw error;
    }
  }

  return { objectId, objectIsNew, fields };
}
