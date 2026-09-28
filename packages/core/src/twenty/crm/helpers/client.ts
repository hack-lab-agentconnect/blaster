/**
 * Twenty CRM REST client.
 *
 * Ported from the patterns that work against a real Twenty workspace, with the
 * three sharp edges handled explicitly:
 *
 *   1. This Twenty version ignores cursor parameters. `startingAfter`,
 *      `offset`, and `page` all return page one, so paging walks `id` strictly
 *      ascending instead: `orderBy=id[AscNullsFirst]` with
 *      `filter=id[gt]:"<last id seen>"`. Ids are unique, so pages are disjoint
 *      and the walk terminates.
 *   2. The response envelope varies. The same list endpoint has been observed
 *      returning a bare array, `{data:{<plural>}}`, `{data:{data:{<plural>}}}`,
 *      `{data:T[]}`, `rows`, and GraphQL `edges[].node`. `unwrapList` accepts
 *      all of them rather than assuming one.
 *   3. A `SELECT` field arrives as either a bare string or `{value,label}`
 *      depending on how it was written. Every read goes through `selectValue`.
 *
 * Record reads use REST. GraphQL is only used for workspace metadata, because
 * the REST endpoints are generated from the live schema and therefore serve the
 * custom `agency*` objects that the core objects API rejects.
 */

export interface TwentyConfig {
  baseUrl: string;
  apiKey: string;
}

export interface TwentyRecord {
  id: string;
  [key: string]: unknown;
}

export interface TwentyPage<T> {
  records: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

export class TwentyError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, detail: string) {
    super(`Twenty ${status} on ${path}: ${detail}`);
    this.name = "TwentyError";
    this.status = status;
    this.path = path;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TwentyConfig {
  const baseUrl = env.TWENTY_BASE_URL;
  const apiKey = env.TWENTY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("TWENTY_BASE_URL and TWENTY_API_KEY are required");
  }
  // The trailing slash is stripped here so path joins never produce a double
  // slash, which Twenty answers with a 404 rather than a redirect.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function toCamelCase(value: string): string {
  return value.replace(/[-_]([a-z])/g, (_, char: string) => char.toUpperCase());
}

function toSingular(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function objectKeyFor(path: string): string {
  const clean = path.replace(/^\//, "").split("?")[0]?.split("/")[0] ?? "";
  return toCamelCase(clean);
}

/**
 * Pull the record array out of whichever envelope Twenty returned.
 * Returns an empty array rather than throwing when the shape is unrecognised,
 * so a schema change surfaces as "no records" instead of a crash.
 */
export function unwrapList<T>(payload: unknown, path: string): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as T[];

  const record = payload as Record<string, unknown>;
  const data = (record.data as Record<string, unknown> | undefined)?.data
    ? ((record.data as Record<string, unknown>).data as Record<string, unknown>)
    : (record.data as Record<string, unknown> | undefined);

  if (!data) {
    const rows = record.rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  if (Array.isArray(data)) return data as T[];

  const objectKey = objectKeyFor(path);
  const singular = toSingular(objectKey);

  for (const key of [objectKey, objectKey.replace(/^\//, ""), singular]) {
    const candidate = data[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  if (Array.isArray(data.rows)) return data.rows as T[];

  const edges = data.edges;
  if (Array.isArray(edges)) {
    return edges
      .map((edge) => (edge as { node?: T }).node)
      .filter((node): node is T => node !== undefined);
  }

  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/** Pull a single record out of whichever envelope Twenty returned. */
export function unwrapItem<T>(payload: unknown, path: string): T | null {
  if (!payload) return null;
  if (Array.isArray(payload)) return (payload[0] as T | undefined) ?? null;

  const record = payload as Record<string, unknown>;
  const data = (record.data as Record<string, unknown> | undefined)?.data
    ? ((record.data as Record<string, unknown>).data as Record<string, unknown>)
    : (record.data as Record<string, unknown> | undefined);

  const source = (data ?? record) as Record<string, unknown>;
  if (source.id) return source as T;

  const objectKey = objectKeyFor(path);
  for (const key of [
    toSingular(objectKey),
    objectKey,
    `create${toSingular(objectKey)}`,
    `update${toSingular(objectKey)}`,
  ]) {
    const candidate = source[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as T;
    }
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { id?: unknown }).id) {
      return value as T;
    }
  }
  return null;
}

/**
 * A `SELECT` field is written either as a bare string or as `{value,label}`.
 * Callers want the value.
 */
export function selectValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object") {
    const composite = value as { value?: unknown; label?: unknown };
    if (typeof composite.value === "string" && composite.value) return composite.value;
    if (typeof composite.label === "string" && composite.label) return composite.label;
  }
  return undefined;
}

export interface ListOptions {
  limit?: number;
  /** Twenty filter DSL, e.g. `name[eq]:INDUSTRY:plumbing`. */
  filter?: string;
  startingAfter?: string;
}

/** Twenty caps `limit` at 200 and ignores higher values. */
const LIMIT_CEILING = 200;

export class TwentyClient {
  private readonly config: TwentyConfig;

  constructor(config: TwentyConfig = loadConfig()) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private cleanPath(path: string): string {
    return path.replace(/^\//, "");
  }

  async raw(path: string, init: RequestInit = {}): Promise<unknown> {
    const clean = this.cleanPath(path);
    const response = await fetch(`${this.config.baseUrl}/rest/${clean}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
      throw new TwentyError(response.status, `/${clean}`, detail);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * One keyset page. `startingAfter` is the last id of the previous page, and
   * it takes the place of the caller's filter, so a filtered walk has to
   * combine them itself via `combineFilters`.
   */
  async listPage<T = TwentyRecord>(path: string, options: ListOptions = {}): Promise<TwentyPage<T>> {
    const limit = Math.min(Math.max(options.limit ?? LIMIT_CEILING, 1), LIMIT_CEILING);
    const url = new URL(`${this.config.baseUrl}/rest/${this.cleanPath(path)}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("orderBy", "id[AscNullsFirst]");
    if (options.startingAfter) {
      url.searchParams.set("filter", `id[gt]:"${options.startingAfter}"`);
    } else if (options.filter) {
      url.searchParams.set("filter", options.filter);
    }

    const response = await fetch(url.toString(), { headers: this.headers() });
    if (!response.ok) {
      const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
      throw new TwentyError(response.status, `/${this.cleanPath(path)}`, detail);
    }

    const payload: unknown = await response.json();
    const records = unwrapList<T>(payload, path);
    // T is unconstrained, so the id is read through the record shape rather
    // than assumed to be on every generic.
    const ids = records
      .map((record) => (record as TwentyRecord | undefined)?.id)
      .filter((id): id is string => typeof id === "string");

    return {
      records,
      hasNextPage: records.length >= limit,
      endCursor: ids.length > 0 ? (ids[ids.length - 1] as string) : null,
      totalCount:
        typeof (payload as { totalCount?: unknown })?.totalCount === "number"
          ? (payload as { totalCount: number }).totalCount
          : 0,
    };
  }

  /** Walk every page. Bounded so a broken cursor cannot spin forever. */
  async listAll<T = TwentyRecord>(path: string, options: ListOptions = {}): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result: TwentyPage<T> = await this.listPage<T>(path, { ...options, startingAfter: cursor });
      all.push(...result.records);
      if (!result.hasNextPage || !result.endCursor) break;
      cursor = result.endCursor;
    }
    return all;
  }

  async get<T = TwentyRecord>(path: string, id: string): Promise<T | null> {
    const payload = await this.raw(`${this.cleanPath(path)}/${encodeURIComponent(id)}`);
    return unwrapItem<T>(payload, path);
  }

  async create<T = TwentyRecord>(path: string, data: unknown): Promise<T | null> {
    const payload = await this.raw(this.cleanPath(path), {
      method: "POST",
      body: JSON.stringify(data),
    });
    return unwrapItem<T>(payload, path);
  }

  async update<T = TwentyRecord>(path: string, id: string, data: unknown): Promise<T | null> {
    const payload = await this.raw(`${this.cleanPath(path)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    return unwrapItem<T>(payload, path);
  }

  /**
   * GraphQL, for workspace metadata only. Records go through REST because the
   * REST routes are generated from the live schema and cover the custom
   * `agency*` objects.
   */
  async graphql<T = unknown>(query: string): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}/graphql`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
      throw new TwentyError(response.status, "/graphql", detail);
    }
    const json = (await response.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) {
      throw new TwentyError(422, "/graphql", JSON.stringify(json.errors).slice(0, 300));
    }
    return json.data as T;
  }

  /** Whether a custom object exists in this workspace. */
  async hasObject(nameSingular: string): Promise<boolean> {
    const data = await this.graphql<{
      objects: { edges: Array<{ node: { nameSingular: string; namePlural: string } }> };
    }>(`query { objects(paging: { first: 200 }) { edges { node { id nameSingular namePlural } } } }`);
    return data.objects.edges.some(
      (edge) => edge.node.nameSingular === nameSingular || edge.node.namePlural === nameSingular,
    );
  }
}

/** Combine a caller filter with a keyset cursor, since the cursor replaces it. */
export function combineFilters(filter: string | undefined, cursor: string | undefined): string | undefined {
  const keyset = cursor ? `id[gt]:"${cursor}"` : undefined;
  if (filter && keyset) return `(${filter}) AND ${keyset}`;
  return filter ?? keyset;
}
