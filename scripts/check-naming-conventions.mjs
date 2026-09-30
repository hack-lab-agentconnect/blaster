// Pre-push gate: the backend naming convention in docs/naming-conventions.md.
//
// The rule is scoped to BACKEND source. A React tree is organised by screen and
// component, which is a different and correct convention, so apps/web is not
// checked: renaming a component tree to satisfy a rule written for server
// modules would make it worse, not better.
//
// What this enforces, per docs/naming-conventions.md:
//   1. Library and domain directories are lowercase kebab-case.
//   2. Backend .ts file names are lowercase kebab-case.
//   3. Every domain has index.ts and types.ts.
//   4. Every helpers/ directory has an index.ts barrel.
//   5. No helper imports its parent domain barrel (../index), which would make
//      the barrel depend on its own helpers.
//   6. A domain index.ts uses named exports, not `export *`, so a domain's
//      public surface is readable without opening every helper.
//
// Generated trees are exempt: their file names and exports belong to the
// generator, and editing them is undone by the next run.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Kebab-case: lowercase, digits, and single internal hyphens. */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Twenty names a domain directory is allowed to mirror, read from the checked-in
 * allowlist rather than from the network.
 *
 * The naming rule is "the external system wins": a module mirroring a Twenty
 * object keeps Twenty's spelling, and Twenty's objects are camelCase. So a
 * camelCase directory is legal only when it is one of these names. That keeps
 * the gate able to tell a deliberate mirror (`twenty/agencyPhone/`) from a typo
 * (`twenty/AgencyPhones/`), which is the failure the rule exists to prevent.
 * Regenerate with `pnpm twenty:objects`.
 */
const TWENTY_MIRRORS = new Set(
  (() => {
    try {
      const list = JSON.parse(readFileSync(join(root, "config/twenty-objects.json"), "utf8"));
      return Array.isArray(list.objects) ? list.objects : [];
    } catch {
      return [];
    }
  })(),
);

/** True when `name` is a legal directory name: kebab-case, or a Twenty mirror. */
function legalDirectoryName(name) {
  return KEBAB.test(name) || TWENTY_MIRRORS.has(name);
}

/** Directory trees exempt from every rule, with the reason each exists. */
const EXEMPT_TREES = [
  { segment: "generated", reason: "machine output, overwritten by its generator" },
  { segment: "_generated", reason: "machine output, overwritten by its generator" },
  { segment: "node_modules", reason: "not our source" },
];

/**
 * Backend roots, each of which holds library or domain directories directly.
 * Any packages/<name>/src is discovered automatically, so adding a package
 * needs no edit here; an app has to be listed.
 *
 * `apps/api/src` is not a root: it holds a process entry (`index.ts`, which
 * binds the port) plus `lib/`, so the root is one level deeper.
 *
 * `convex/` is deliberately absent. That tree belongs to the Convex framework,
 * which fixes its own file names (`convex.config.ts` is required by name, and
 * its function modules are camelCase by the framework's convention). Our rule
 * is ours to apply to our source; applying it there would mean fighting the
 * tool, so the tree is out of scope rather than exempted.
 */
const BACKEND_ROOTS = ["lib", "apps/api/src/lib"];

const violations = [];
const report = (path, message) => violations.push(`${path}: ${message}`);

/** True when any path segment marks this file as generated output. */
function isGenerated(segments) {
  return segments.some((segment) =>
    EXEMPT_TREES.some((tree) => segment === tree.segment),
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXEMPT_TREES.some((tree) => entry.name === tree.segment)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Check one backend root: directory names, file names, barrels, exports. */
function checkRoot(rootPath, label) {
  if (!existsSync(rootPath)) return false;

  // A root holds either standalone domains (each with its own index.ts) or
  // libraries that contain domain subdirectories.
  const entries = readdirSync(rootPath, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) {
    report(label, "Must contain at least one domain or library directory.");
    return true;
  }

  const hasIndex = (path) => existsSync(join(path, "index.ts"));

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (!legalDirectoryName(entry.name)) {
      report(
        `${label}/${entry.name}`,
        TWENTY_MIRRORS.size === 0
          ? "Directory name must be lowercase kebab-case (config/twenty-objects.json is missing or empty, so no Twenty mirror is recognised)."
          : "Directory name must be lowercase kebab-case, or exactly a Twenty object name from config/twenty-objects.json.",
      );
    }

    if (hasIndex(entryPath)) {
      checkDomain(entryPath, `${label}/${entry.name}`);
      continue;
    }

    // A library directory: every domain beneath it must be well formed.
    for (const domain of readdirSync(entryPath, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      if (!legalDirectoryName(domain.name)) {
        report(
          `${label}/${entry.name}/${domain.name}`,
          "Domain name must be lowercase kebab-case, or exactly a Twenty object name from config/twenty-objects.json.",
        );
      }
      checkDomain(join(entryPath, domain.name), `${label}/${entry.name}/${domain.name}`);
    }
  }

  // File names anywhere under the root.
  for (const file of walk(rootPath)) {
    const rel = relative(rootPath, file);
    const segments = rel.split(sep);
    if (isGenerated(segments)) continue;
    if (!file.endsWith(".ts")) continue;
    if (segments.includes("test")) continue;

    const name = basename(file, ".ts");
    if (name !== "index" && !KEBAB.test(name)) {
      report(`${label}/${rel}`, `File name must be lowercase kebab-case (got "${name}").`);
    }
  }

  return true;
}

/** A domain needs an entrypoint and, when present, a helpers barrel. */
function checkDomain(domainPath, label) {
  if (!existsSync(join(domainPath, "index.ts"))) {
    report(label, 'Missing required entrypoint "index.ts".');
    return;
  }

  const helpersPath = join(domainPath, "helpers");
  if (!existsSync(helpersPath)) return;
  if (!existsSync(join(helpersPath, "index.ts"))) {
    report(`${label}/helpers`, 'Missing required barrel "helpers/index.ts".');
  }
  for (const file of readdirSync(helpersPath).filter((f) => f.endsWith(".ts"))) {
    if (file === "index.ts") continue;
    const lines = readFileSync(join(helpersPath, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const importsParentBarrel =
        (line.includes('from "../index') || line.includes('from "../index')) &&
        !line.trim().startsWith("//");
      if (importsParentBarrel) {
        report(
          `${label}/helpers/${file}:${index + 1}`,
          "A helper must not import its parent domain barrel; that makes the barrel depend on its own helpers.",
        );
      }
    });
  }
}

const checked = [];

for (const relative_root of BACKEND_ROOTS) {
  const path = join(root, relative_root);
  if (checkRoot(path, relative_root)) checked.push(relative_root);
}

// Every packages/<name>/src is a backend root by construction.
const packagesDir = join(root, "packages");
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !KEBAB.test(entry.name)) continue;
    const srcDir = join(packagesDir, entry.name, "src");
    if (existsSync(srcDir) && checkRoot(srcDir, `packages/${entry.name}/src`)) {
      checked.push(`packages/${entry.name}/src`);
    }
  }
}

if (checked.length === 0) {
  console.log("check-naming-conventions: no backend roots found, skipping.");
  process.exit(0);
}

if (violations.length > 0) {
  console.error(`pre-push: FAIL - ${violations.length} naming convention violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("\nSee docs/naming-conventions.md for the required backend structure.");
  process.exit(1);
}

console.log(
  `pre-push: OK - ${checked.join(", ")} follow the backend {library}/{domain} convention.`,
);
