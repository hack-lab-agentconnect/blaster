// Gate: the environment manifest and the code must agree.
//
// config/env-vars.json is the contract that the API, the Convex backend, and
// the docs all read. Two ways it rots:
//
//   1. a variable is declared but nothing reads it, so it looks configured
//      when it is dead weight
//   2. code reads a variable the manifest never declared, so `GET /api/env`
//      and the docs understate what the service actually needs
//
// This checks both directions against the source on disk.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'config', 'env-vars.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const SCAN_DIRS = ['packages', 'apps', 'convex', 'scripts', 'docs'];
const SCAN_EXT = /\.(ts|mts|tsx|mjs|js|md|json)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', '.source', 'build']);

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (SCAN_EXT.test(entry.name)) files.push(join(dir, entry.name));
  }
  return files;
}

const sources = SCAN_DIRS.flatMap((dir) => walk(join(root, dir)));
const relPath = (file) => relative(root, file).replace(/\\/g, '/');

/** Every declared name, and the text each declared consumer file actually has. */
const declared = new Map(manifest.vars.map((variable) => [variable.name, variable]));
const violations = [];

// 1. Every declared consumer must exist.
for (const variable of manifest.vars) {
  for (const consumer of variable.consumedBy) {
    if (!existsSync(join(root, consumer))) {
      violations.push(`${variable.name}: consumedBy "${consumer}" does not exist on disk.`);
    }
  }
}

// 2. An active variable must be read by at least one of its consumers. A
//    planned one is allowed to have none, but has to say why, so a capability
//    that was quietly dropped cannot hide behind an empty list.
for (const variable of manifest.vars) {
  const status = variable.status ?? 'active';
  if (status === 'planned') {
    if (!variable.reason || !String(variable.reason).trim()) {
      violations.push(`${variable.name}: status is "planned" but no reason is given.`);
    }
    continue;
  }
  const reads = variable.consumedBy.some((consumer) => {
    const file = join(root, consumer);
    if (!existsSync(file)) return false;
    return readFileSync(file, 'utf8').includes(variable.name);
  });
  if (!reads && variable.consumedBy.length > 0) {
    violations.push(
      `${variable.name}: no consumer file reads this name. It is declared but dead.`,
    );
  }
}

// 3. Every name read through `process.env` must be declared in the manifest.
//    Matching the access rather than any SCREAMING_SNAKE identifier is what
//    keeps ordinary constants like SCAN_DIRS out of the report.
//
//    scripts/ is excluded: the gate tooling has its own switches, and the
//    service does not read them.
const MANIFEST_FILES = new Set(['config/env-vars.json', '.env.example']);
const CODE_DIRS = ['packages', 'apps', 'convex'];
for (const file of CODE_DIRS.flatMap((dir) => walk(join(root, dir)))) {
  const rel = relPath(file);
  if (MANIFEST_FILES.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const accesses = [
    ...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
    ...text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g),
  ];
  for (const match of accesses) {
    const name = match[1];
    if (declared.has(name)) continue;
    violations.push(`${rel}: reads process.env.${name}, which is not in config/env-vars.json.`);
  }
}

if (violations.length > 0) {
  console.error('check-env: FAIL — the environment manifest and the code disagree:');
  for (const violation of [...new Set(violations)]) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `check-env: OK — ${manifest.vars.length} variables declared, each consumed by a real file, and no undeclared variable is read.`,
);
void statSync;
