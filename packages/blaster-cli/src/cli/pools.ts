/**
 * `blaster pools ...`: manage number pools and assign one to a sequence.
 *
 * Every command goes through the shared `createBlasterApiClient`, so what a
 * script does here is what the MCP tools and the HTTP routes do. Scriptable and
 * prompt-free: anything a script would supply is a flag, and a missing flag is
 * a message naming it rather than a hang.
 */

import {
  BlasterApiError,
  createBlasterApiClient,
  type BlasterApiClient,
  type PoolDetail,
  type PoolSummary,
} from "@blaster/core";
import { loadHome, type SessionRecord } from "./login.ts";
import type { CliFlags } from "./inbox.ts";

export const POOLS_USAGE = `Usage: blaster pools <action>

  list                          Every pool, newest first
  show <pool-id>                One pool with its numbers in order
  create --name <name> [--min-spacing <ms>] [--daily-cap <n>]
                                Create a pool
  add-number --pool <id> --number <e164> [--order <n>]
                                Add a number (or reactivate a removed one)
  remove-number --pool <id> --number <e164>
                                Remove a number. Soft: the membership is kept
  reorder --pool <id> --order <e164,e164,...>
                                Set the order the pool works its numbers in
  assign --sequence <id> [--pool <id>]
                                Assign a pool to a sequence; omit --pool to clear

A pool assigned to a sequence supplies the sending number at send time, in pool
order and within each number's rate budget, so work is deferred instead of being
pushed into the carrier's limit queue.

Options
  --api-url <url>               The API to read, defaulting to the signed-in one
  --json                        Machine-readable output

Reads the operator session written by "blaster login". Nothing here prompts.`;

function clientFromSession(flags: CliFlags, root: string): BlasterApiClient | number {
  const home = loadHome(root);
  const explicit = typeof flags.get("api-url") === "string" ? (flags.get("api-url") as string) : null;
  const apiUrl = explicit ?? home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
  if (!apiUrl) {
    console.error('blaster pools: no signed-in API. Run "blaster login" first, or pass --api-url.');
    return 1;
  }
  const session: SessionRecord | undefined = home.sessions[apiUrl];
  if (!session) {
    console.error(`blaster pools: no session for ${apiUrl}. Run "blaster login" first.`);
    return 1;
  }
  return createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken });
}

function report(error: unknown, json: boolean): number {
  if (error instanceof BlasterApiError) {
    if (error.kind === "unauthorized") {
      const message = "The operator token is not accepted. Run \"blaster login\" again.";
      console.error(json ? JSON.stringify({ error: message, kind: error.kind }, null, 2) : `blaster pools: ${message}`);
      return 1;
    }
    console.error(json ? JSON.stringify({ error: error.message, kind: error.kind, status: error.status }, null, 2) : `blaster pools: ${error.message} (${error.status})`);
    return error.kind === "unavailable" || error.kind === "server" ? 2 : 1;
  }
  console.error(`blaster pools: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

const text = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

function formatPoolList(pools: PoolSummary[]): string {
  if (pools.length === 0) return "No pools yet.";
  return pools
    .map(
      (pool) =>
        `${pool.id}  ${pool.name}  [${pool.status}]  ` +
        `${pool.activeNumberCount} active  next ${new Date(pool.nextAvailableAt).toISOString()}`,
    )
    .join("\n");
}

function formatPool(pool: PoolDetail): string {
  const lines = [
    `${pool.name} (${pool.id})`,
    `status=${pool.status} strategy=${pool.strategy} cursor=${pool.cursor}`,
    `spacing=${pool.minSpacingMs}ms dailyCapPerNumber=${pool.dailyCapPerNumber} active=${pool.activeNumberCount}`,
    `nextAvailableAt=${new Date(pool.nextAvailableAt).toISOString()}`,
    "numbers:",
  ];
  for (const number of pool.numbers) {
    lines.push(
      `  ${String(number.order).padStart(3)}  ${number.phoneNumber}  ` +
        `[${number.status}] sentToday=${number.sentToday} next=${new Date(number.nextAvailableAt).toISOString()}`,
    );
  }
  return lines.join("\n");
}

export async function poolsMain(
  rest: string[],
  flags: CliFlags,
  json: boolean,
  root: string = process.cwd(),
): Promise<number> {
  const action = rest[0];
  const client = clientFromSession(flags, root);
  if (typeof client === "number") return client;

  try {
    switch (action) {
      case "list":
      case "ls": {
        const pools = await client.listPools();
        console.log(json ? asJson({ count: pools.length, pools }) : formatPoolList(pools));
        return 0;
      }

      case "show": {
        const id = rest[1];
        if (!id) {
          console.error(`blaster pools show needs a pool id\n${POOLS_USAGE}`);
          return 1;
        }
        const pool = await client.getPool(id);
        if (!pool) {
          console.error(`blaster pools: unknown pool ${id}`);
          return 1;
        }
        console.log(json ? asJson(pool) : formatPool(pool));
        return 0;
      }

      case "create":
      case "new": {
        const name = text(flags.get("name")) ?? rest[1];
        if (!name) {
          console.error(`blaster pools create: --name is required\n${POOLS_USAGE}`);
          return 1;
        }
        const spacing = text(flags.get("min-spacing"));
        const dailyCap = text(flags.get("daily-cap"));
        const created = await client.createPool({
          name,
          ...(spacing === undefined ? {} : { minSpacingMs: Number(spacing) }),
          ...(dailyCap === undefined ? {} : { dailyCapPerNumber: Number(dailyCap) }),
        });
        console.log(json ? asJson(created) : `Created pool ${created.id}.`);
        return 0;
      }

      case "add-number": {
        const poolId = text(flags.get("pool"));
        const phoneNumber = text(flags.get("number"));
        if (!poolId || !phoneNumber) {
          console.error(`blaster pools add-number: --pool and --number are required\n${POOLS_USAGE}`);
          return 1;
        }
        const orderRaw = text(flags.get("order"));
        const pool = await client.addPoolNumber({
          poolId,
          phoneNumber,
          ...(orderRaw === undefined ? {} : { order: Number(orderRaw) }),
        });
        console.log(json ? asJson(pool) : formatPool(pool));
        return 0;
      }

      case "remove-number":
      case "rm-number": {
        const poolId = text(flags.get("pool"));
        const phoneNumber = text(flags.get("number"));
        if (!poolId || !phoneNumber) {
          console.error(`blaster pools remove-number: --pool and --number are required\n${POOLS_USAGE}`);
          return 1;
        }
        const pool = await client.removePoolNumber({ poolId, phoneNumber });
        console.log(json ? asJson(pool) : formatPool(pool));
        return 0;
      }

      case "reorder": {
        const poolId = text(flags.get("pool"));
        const orderRaw = text(flags.get("order"));
        if (!poolId || !orderRaw) {
          console.error(`blaster pools reorder: --pool and --order are required\n${POOLS_USAGE}`);
          return 1;
        }
        const order = orderRaw.split(",").map((item) => item.trim()).filter(Boolean);
        const pool = await client.reorderPoolNumbers({ poolId, order });
        console.log(json ? asJson(pool) : formatPool(pool));
        return 0;
      }

      case "assign": {
        const sequenceId = text(flags.get("sequence"));
        if (!sequenceId) {
          console.error(`blaster pools assign: --sequence is required\n${POOLS_USAGE}`);
          return 1;
        }
        const poolId = text(flags.get("pool"));
        const result = await client.setSequencePool({
          sequenceId,
          ...(poolId === undefined ? {} : { poolId }),
        });
        console.log(
          json
            ? asJson(result)
            : poolId
              ? `Assigned pool ${poolId} to sequence ${sequenceId}.`
              : `Cleared the pool assignment on sequence ${sequenceId}.`,
        );
        return 0;
      }

      default: {
        console.error(`blaster pools: unknown action "${action}"\n${POOLS_USAGE}`);
        return 1;
      }
    }
  } catch (error) {
    return report(error, json);
  }
}
