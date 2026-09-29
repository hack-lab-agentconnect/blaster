// Pre-push gate: brand rule — no monospace font may render anywhere.
// Scans source for `font-mono` (Tailwind) and mono font stacks (ui-monospace,
// Menlo, Monaco, …) in inline styles. Fails with the offending file:line list.
// Run by lefthook (see lefthook.yml). Bypass for emergencies only:
//   SKIP_FONT_MONO_CHECK=1 git push
// Scanner test: FONT_MONO_TEST_DIR=<path> node scripts/check-no-font-mono.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);

if (process.env.SKIP_FONT_MONO_CHECK) {
  console.log('pre-push: SKIP_FONT_MONO_CHECK set, skipping font-mono check.');
  process.exit(0);
}

const SCAN_DIRS = [
  'packages',
  'apps',
  'convex',
  'config',
  'docs',
  'scripts',
  'README.md',
];

// Vendored upstream documentation mirrors, scoped to docs/ by path so this
// repository's own `convex/` source is still checked.
const VENDORED_DOC_DIRS = new Set([
  'convex',
  'telnyx',
  'treg',
  'agentmail',
  'hono',
  'nebius',
  'typesafe',
  'clerk',
  'fumadocs',
]);

function isVendoredDocDir(dir) {
  const rel = relative(join(root, 'docs'), dir).replace(/\\/g, '/');
  return VENDORED_DOC_DIRS.has(rel);
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.mdx', '.md']);

// The docs re-point --font-mono at the sans stack so no monospace CAN render
// there; that definition line is the sanctioned exception (see the comment
// above it in the file).
const EXEMPTIONS = [{ file: 'apps/docs/app/globals.css', line: /--font-mono\s*:/ }];

// Referring to this gate by name is not a font declaration. The script is called
// check:no-font-mono, so any table or sentence that documents it would otherwise
// fail its own rule, which is how a gate teaches people to route around it.
const NAME_MENTION = /(^|[^\w-])(?:check:)?no-font-mono([^\w-]|$)/;

// Machine-written files are not design decisions. The generated Twenty client
// (packages/core/src/twenty/api/generated) is a verbatim print of the
// workspace's own GraphQL schema, and that schema contains enum values such as
// the country 'MONACO'. Nothing in these files can render, so the marker the
// emitter stamps is what exempts them, not a path allowlist that would rot.
const GENERATED_MARKER = /^\s*\/\/\s*@generated\b/m;

// The Tailwind class that resolves to a mono stack, plus concrete mono faces
// in inline styles. Case-insensitive so renamed/capitalized stacks still trip.
const PATTERNS = [
  'font-mono',
  'fontmodule',
  'fontmono',
  'ui-monospace',
  'sfmono',
  'menlo',
  'monaco',
  'consolas',
  'courier',
  'jetbrains mono',
  'fira code',
  'source code',
  'roboto mono',
  'ibm plex mono',
  'cascadia',
  'liberation mono',
  'dejavu sans mono',
  'noto sans mono',
  'lucida console',
  'andale mono',
  'pt mono',
  'mononoki',
];
const regex = new RegExp(PATTERNS.join('|'), 'i');

function scanFile(absPath, violations) {
  if (resolve(absPath) === selfPath) return;
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const rel = relative(root, absPath).replace(/\\/g, '/');
  if (GENERATED_MARKER.test(text)) return;
  const exemption = EXEMPTIONS.find((e) => e.file === rel);
  text.split('\n').forEach((line, i) => {
    if (!regex.test(line)) return;
    if (NAME_MENTION.test(line)) return;
    if (exemption && exemption.line.test(line)) return;
    violations.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
      if (isVendoredDocDir(full)) continue;
      walk(full, out);
      continue;
    }
    if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot > 0 && SCAN_EXT.has(entry.name.slice(dot).toLowerCase())) out.push(full);
    }
  }
}

const targets = [];
for (const target of process.env.FONT_MONO_TEST_DIR !== undefined ? [process.env.FONT_MONO_TEST_DIR] : SCAN_DIRS.map((p) => join(root, p))) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    continue;
  }
  if (stat.isDirectory()) walk(target, targets);
  else if (stat.isFile()) targets.push(target);
}

const violations = [];
for (const file of targets) scanFile(file, violations);

if (violations.length > 0) {
  console.error('pre-push: FAIL — monospace font usage (brand rule: Satoshi/Inter only, no mono).');
  for (const v of violations) console.error(`  ${v}`);
  console.error('Remove the mono class/stack so the app sans stack (Satoshi/Inter) is used instead.');
  process.exit(1);
}

console.log('pre-push: OK — no monospace font usage found.');