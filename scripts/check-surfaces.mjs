// Pre-push gate: the capability registry, the MCP tools, and the HTTP routes
// agree.
//
// The CLI's `CAPABILITIES` table is the one place a capability names its CLI,
// MCP, and HTTP surface. Nothing enforced it, so it drifted: it advertised an
// MCP tool (`blaster_list_phones`) and an HTTP route (`GET /api/records/:object`)
// that do not exist. This gate makes the table load-bearing — a capability that
// names a surface the build does not have fails here.
//
// It checks, without executing anything:
//   - every registered MCP tool is advertised and implemented in the MCP server;
//   - every HTTP route a capability names exists in the Hono surface;
//   - capability ids are unique.
//
// It reads source with a regex rather than importing, because the CLI, the MCP
// server, and the API each have their own entry side effects and build wiring.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const CLI_SOURCE = join(root, "packages/blaster-cli/src/cli/index.ts");
const MCP_SOURCE = join(root, "packages/blaster-mcp/src/mcp/index.ts");
const API_SOURCE = join(root, "apps/api/src/index.ts");

const violations = [];
const report = (message) => violations.push(message);

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    report(`${path}: cannot be read.`);
    return "";
  }
}

/** `{ id, cli, mcp, http }` rows from the CLI capability registry. */
function capabilities(source) {
  const pattern =
    /\{\s*id:\s*"([^"]+)",\s*cli:\s*"([^"]*)",\s*mcp:\s*"([^"]*)",\s*http:\s*"([^"]*)"\s*\}/g;
  const rows = [];
  for (const match of source.matchAll(pattern)) {
    rows.push({ id: match[1], cli: match[2], mcp: match[3], http: match[4] });
  }
  return rows;
}

/** MCP tool names that are advertised in the tool table. */
function advertisedTools(source) {
  const names = new Set();
  for (const match of source.matchAll(/name:\s*"(blaster_[a-z_]+)"/g)) names.add(match[1]);
  return names;
}

/** MCP tool names that have an implementation arm in `runTool`. */
function implementedTools(source) {
  const names = new Set();
  for (const match of source.matchAll(/case\s+"(blaster_[a-z_]+)":/g)) names.add(match[1]);
  return names;
}

/** Every `METHOD /path` the Hono surface registers, with the `/api` prefix resolved. */
function httpRoutes(source) {
  const routes = new Set();
  const pattern = /\b(app|inbox|pools)\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const [, app, method, path] = match;
    const full = app === "app" ? path : `/api${path}`;
    routes.add(`${method.toUpperCase()} ${full}`);
  }
  return routes;
}

function check() {
  const cli = read(CLI_SOURCE);
  const mcp = read(MCP_SOURCE);
  const api = read(API_SOURCE);
  if (violations.length > 0) return; // a missing source is the only failure so far

  const caps = capabilities(cli);
  if (caps.length === 0) report(`${CLI_SOURCE}: no capabilities were found in the registry.`);

  const seen = new Set();
  for (const cap of caps) {
    if (seen.has(cap.id)) report(`capability "${cap.id}" is registered more than once.`);
    seen.add(cap.id);
  }

  const advertised = advertisedTools(mcp);
  const implemented = implementedTools(mcp);
  const routes = httpRoutes(api);

  for (const name of advertised) {
    if (!implemented.has(name)) report(`MCP tool "${name}" is advertised but has no runTool case.`);
  }
  for (const name of implemented) {
    if (!advertised.has(name)) report(`MCP tool "${name}" has a runTool case but is not advertised.`);
  }

  for (const cap of caps) {
    if (cap.mcp && !advertised.has(cap.mcp)) {
      report(`capability "${cap.id}" names MCP tool "${cap.mcp}", which the MCP server does not advertise.`);
    }
    if (cap.http) {
      const space = cap.http.indexOf(" ");
      const method = space === -1 ? "" : cap.http.slice(0, space).toUpperCase();
      const path = space === -1 ? "" : cap.http.slice(space + 1);
      if (!method || !path.startsWith("/")) {
        report(`capability "${cap.id}" has an unparsable http surface "${cap.http}".`);
      } else if (!routes.has(`${method} ${path}`)) {
        report(`capability "${cap.id}" names HTTP route "${cap.http}", which the API does not register.`);
      }
    }
  }
}

check();

if (violations.length > 0) {
  console.error(`pre-push: FAIL - ${violations.length} surface mismatch(es):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("\nSee docs/pools.md and the CAPABILITIES registry in packages/blaster-cli/src/cli/index.ts.");
  process.exit(1);
}
console.log("pre-push: OK - capabilities, MCP tools, and HTTP routes agree.");
