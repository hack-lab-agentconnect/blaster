// Pre-push gate: the Convex naming convention in docs/convex-naming-conventions.md.
//
// Enforces only what is objectively checkable without understanding intent:
// file and directory casing, the presence and shape of the framework-required
// root files, no function re-export barrels (which would publish every function
// under a second API address), and no api.* references inside convex/ (which
// backend-only calls must avoid in favour of internal.*).
//
// Content checks run against code with comments and string literals stripped,
// so a commented-out line neither flags nor hides a real violation. Anything
// needing judgment (good domain boundaries, good table names, whether a model
// delegates enough) stays in the doc's G-rules, never here.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, sep, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** camelCase or a single lowercase word: `phoneNumbers`, `schema`, `http`. */
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Exact names allowed despite failing the casing rule, and only at the tree
 * root. `convex.config.ts` is a framework-required name; `tsconfig.json`
 * passes the casing rule on its own ("tsconfig") and needs no exemption.
 */
const ROOT_ONLY_NAMES = new Set(["convex.config.ts"]);

/** Trees the gate never scans. */
const EXEMPT = new Set(["_generated", "generated", "node_modules"]);

const violations = [];
const report = (path, message) => violations.push(`${path}: ${message}`);

/**
 * Strip comments and string literals so content checks see code, not prose.
 * A commented-out `export *` must not flag; a real `api.users.get` hiding in
 * a template literal would be missed, which is documented in the doc rather
 * than guessed at here.
 */
function stripNonCode(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      i += 1;
      while (i < text.length && text[i] !== quote) {
        i += text[i] === "\\" ? 2 : 1;
      }
      i += 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** An `api.foo.bar` function reference. Single-segment `api.foo` is a namespace, not a call. */
const API_REF = /\bapi\.[A-Za-z_$][\w$]*\.[A-Za-z_$]/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXEMPT.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function baseName(file) {
  return basename(file, extname(file));
}

function checkTree(convexDir, label) {
  if (!existsSync(convexDir)) {
    report(label, "convex/ directory is missing.");
    return;
  }

  // R10: this repository uses schema validation, so root schema.ts is required
  // here. (Upstream Convex permits schemaless apps; see the doc.)
  const schemaPath = join(convexDir, "schema.ts");
  if (!existsSync(schemaPath)) {
    report(`${label}/schema.ts`, "Missing required root schema.ts (repository rule R10).");
  } else if (!/export\s+default\s/.test(stripNonCode(readFileSync(schemaPath, "utf8")))) {
    report(`${label}/schema.ts`, "Root schema.ts must default-export the schema (repository rule R10).");
  }

  // F5/F6 shape checks: presence is optional, shape is not.
  const httpPath = join(convexDir, "http.ts");
  if (existsSync(httpPath) && !/export\s+default\s/.test(stripNonCode(readFileSync(httpPath, "utf8")))) {
    report(`${label}/http.ts`, "Root http.ts must default-export the router (framework requirement F5).");
  }
  const cronsPath = join(convexDir, "crons.ts");
  if (existsSync(cronsPath) && !/cronJobs\s*\(/.test(stripNonCode(readFileSync(cronsPath, "utf8")))) {
    report(`${label}/crons.ts`, "crons.ts must build its schedule with cronJobs() (framework requirement F6).");
  }

  for (const file of walk(convexDir)) {
    const rel = relative(convexDir, file);
    const segments = rel.split(sep);
    const isRoot = segments.length === 1;

    // R1: every directory segment is camelCase or a single lowercase word.
    for (const segment of segments.slice(0, -1)) {
      if (!CAMEL.test(segment)) {
        report(`${label}/${rel}`, `Directory "${segment}" must be camelCase or a single lowercase word.`);
        break;
      }
    }

    // R1: every filename, whatever its extension. Only the framework-required
    // dotted name is exempt, and only at the root where the framework reads it.
    const name = baseName(file);
    const exactAllowed = isRoot && ROOT_ONLY_NAMES.has(basename(file));
    if (!exactAllowed && !CAMEL.test(name)) {
      report(`${label}/${rel}`, `File name must be camelCase or a single lowercase word (got "${name}").`);
    }

    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
    const code = stripNonCode(readFileSync(file, "utf8"));

    // R9: a re-export barrel would publish every function under a second address.
    if (/^\s*export\s+\*\s+from\s/m.test(code)) {
      report(`${label}/${rel}`, "No `export *` barrels in convex/: each function module is its own API address (rule R9). Use explicit `export type` for types.");
    }

    // R8: backend-only calls use internal.*, never api.*.
    if (API_REF.test(code)) {
      report(`${label}/${rel}`, "No api.* references inside convex/: cross-function calls use internal.* (rule R8).");
    }
  }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "check-convex-"));
  const cases = [];
  const write = (rel, text) => {
    const full = join(dir, "convex", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  // Good tree: nested dirs, root indexes, internal-only calls, generated output
  // with names that would fail anywhere else.
  write("schema.ts", `import { defineSchema } from "convex/server";\nimport { userTables } from "./schema/users.js";\nexport default defineSchema({ ...userTables });\n`);
  write("schema/users.ts", `import { defineTable } from "convex/server";\nimport { v } from "convex/values";\nexport const userTables = { users: defineTable({ name: v.string() }) };\n`);
  write("http.ts", `import { httpRouter } from "convex/server";\nconst http = httpRouter();\nexport default http;\n`);
  write("crons.ts", `import { cronJobs } from "convex/server";\nimport { internal } from "./_generated/api.js";\nexport default cronJobs();\n`);
  write("users/queries.ts", `import { query } from "../_generated/server.js";\nimport { internal } from "../_generated/api.js";\n// see internal.users.model for the shared logic\nexport const get = query({ args: {}, handler: async (ctx) => ctx.runQuery(internal.users.model, {}) });\n`);
  write("users/model.ts", `export async function findUser(ctx, id) { return ctx.db.get(id); }\n`);
  write("users/nested/deepQuery.ts", `import { query } from "../../_generated/server.js";\nexport const deep = query({ args: {}, handler: async () => null });\n`);
  write("_generated/api.js", `export const api = {};\n`);
  write("_generated/bad-name.ts", `export * from "./x.js";\nconst y = api.foo.bar;\n`);

  let mark = violations.length;
  checkTree(join(dir, "convex"), "convex");
  cases.push({ name: "good tree", expect: 0, got: violations.length - mark });

  // Bad tree, one violation per defect:
  //   bad-name/           -> directory casing
  //   my_queries.ts       -> file casing
  //   kebab-dir/          -> directory casing (its myQueries.ts is fine)
  //   dupes/index.ts      -> export * barrel
  //   leaky/queries.ts    -> api.* reference in code
  mark = violations.length;
  write("bad-name/my_queries.ts", `export const x = 1;\n`);
  write("kebab-dir/myQueries.ts", `export const x = 1;\n`);
  write("dupes/index.ts", `export * from "./queries.js";\n`);
  write("leaky/queries.ts", `import { api } from "../_generated/api.js";\nexport const x = api.users.get;\n`);
  checkTree(join(dir, "convex"), "convex");
  cases.push({ name: "bad tree", expect: 5, got: violations.length - mark });

  // Misleading matches must not flag: api.* in a comment or a string is prose,
  // and a commented-out barrel is not a barrel.
  mark = violations.length;
  write("clean/notes.ts", `// see api.users.get for the shape we mirror\nconst doc = "api.users.get is documented";\n/* export * from "./old.js"; */\nexport const ok = 1;\n`);
  checkTree(join(dir, "convex"), "convex");
  // Only the bad tree's 5 carry over; this file adds none.
  cases.push({ name: "prose is not code", expect: 5, got: violations.length - mark });

  // Shape checks: schema.ts without a default export, http.ts without one,
  // crons.ts without cronJobs() each flag exactly once.
  const dir2 = mkdtempSync(join(tmpdir(), "check-convex-shapes-"));
  const write2 = (rel, text) => {
    const full = join(dir2, "convex", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  write2("schema.ts", `import { defineSchema } from "convex/server";\nconst schema = defineSchema({});\n`);
  write2("http.ts", `import { httpRouter } from "convex/server";\nconst http = httpRouter();\n`);
  write2("crons.ts", `import { cronJobs } from "convex/server";\nexport const jobs = cronJobs;\n`);
  mark = violations.length;
  checkTree(join(dir2, "convex"), "convex");
  cases.push({ name: "malformed roots", expect: 3, got: violations.length - mark });

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });

  let failures = 0;
  for (const testCase of cases) {
    const ok = testCase.got === testCase.expect;
    if (!ok) failures += 1;
    console.log(`  self-test ${ok ? "ok  " : "FAIL"}  ${testCase.name.padEnd(18)} expected ${testCase.expect}, got ${testCase.got}`);
  }
  if (failures > 0) {
    console.error(`check-convex: self-test failed with ${failures} bad case(s).`);
    process.exit(1);
  }
  console.log("check-convex: self-test OK");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  checkTree(join(root, "convex"), "convex");
  if (violations.length > 0) {
    console.error(`pre-push: FAIL - ${violations.length} convex convention violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("\nSee docs/convex-naming-conventions.md for the convention.");
    process.exit(1);
  }
  console.log("pre-push: OK - convex/ follows the convex naming convention.");
}
