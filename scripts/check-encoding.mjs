// Pre-push gate: no mojibake may be committed.
//
// A past shell edit pattern read UTF-8 punctuation as Windows-1252 and wrote it
// back as UTF-8, leaving valid-but-garbled text (e.g. an em dash plus a broken
// bar where an ellipsis belonged). That damage is invisible to compilers and
// linters, so this gate rejects its signatures: byte-order marks, the Unicode
// replacement character, and known double-encoding artifacts.
//
// Legitimate non-ASCII (em dashes, ellipses, arrows) passes: only the corrupt
// sequences fail. Fails with the offending file:line list.
// Bypass for emergencies only:
//   SKIP_ENCODING_CHECK=1 git push
// Scanner test: ENCODING_TEST_DIR=<path> node scripts/check-encoding.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);

if (process.env.SKIP_ENCODING_CHECK) {
  console.log('pre-push: SKIP_ENCODING_CHECK set, skipping encoding check.');
  process.exit(0);
}

const SCAN_DIRS = [
  'apps',
  'packages',
  'scripts',
  'config',
  'docs',
  'api',
  'convex',
  'vercel.json',
  'package.json',
  'tsconfig.json',
  'lefthook.yml',
];

const SCAN_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.mdx',
  '.md',
  '.json',
  '.yml',
  '.yaml',
]);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  'upstream',
]);

// Vendored upstream documentation mirrors, pulled in as reference material.
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

/** True when `dir` is a vendored documentation suite under docs/. */
function isVendoredDocDir(dir) {
  const rel = relative(join(root, 'docs'), dir).replace(/\\/g, '/');
  return VENDORED_DOC_DIRS.has(rel);
}

// Double-encoding artifacts. A lone em dash (U+2014) or ellipsis (U+2026) is
// fine; an em dash glued to a broken bar, or Latin-1 misreads of UTF-8 lead
// bytes (Ã©, Â·, â\x80¦), never occur in intentional text.
const MOJIBAKE_RES = [
  /\u2014\u00A6/, // em dash + broken bar (was an ellipsis)
  /â€/, // a-circumflex + euro sign (was an em dash / quote)
  /Ã[\u0080-\u00B5]/, // C3 misread (was accented Latin)
  /Â[\u00A0-\u00BF]/, // C2 misread (was punctuation / nbsp)
  /�/, // U+FFFD replacement character
];

function scanFile(absPath, violations) {
  if (resolve(absPath) === selfPath) return;
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const rel = relative(root, absPath).replace(/\\/g, '/');
  if (text.charCodeAt(0) === 0xfeff) {
    violations.push(`${rel}:1: byte-order mark`);
  }
  text.split('\n').forEach((line, i) => {
    for (const re of MOJIBAKE_RES) {
      if (re.test(line)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        break;
      }
    }
  });
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (isVendoredDocDir(full)) continue;
      walk(full, out);
      continue;
    }
    if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot > 0 && SCAN_EXT.has(entry.name.slice(dot).toLowerCase())) {
        out.push(full);
      }
    }
  }
}

const targets = [];
const scanRoots = process.env.ENCODING_TEST_DIR !== undefined
  ? [process.env.ENCODING_TEST_DIR]
  : SCAN_DIRS.map((p) => join(root, p));

for (const target of scanRoots) {
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
  console.error('pre-push: FAIL - mojibake found (double-encoded punctuation, BOMs, or replacement chars).');
  for (const v of violations) console.error(`  ${v}`);
  console.error('Fix the bytes (the file is valid UTF-8 holding the wrong characters) and re-run.');
  process.exit(1);
}

console.log('pre-push: OK - no mojibake found.');
