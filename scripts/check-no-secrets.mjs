// Pre-push gate: no credentials may be committed.
//
// A leak is the worst thing that can happen to this repository, and it is the
// one failure the compiler cannot catch. This gate scans exactly what would be
// pushed (`git ls-files`) rather than the working tree, so it also ignores the
// gitignored vendored documentation, which legitimately contains example keys in
// code samples.
//
// Three checks:
//   1. No forbidden file is tracked: .env, .env.local, private keys, and the
//      sort of file a password ends up in by accident.
//   2. No tracked file contains a credential matching a known provider shape.
//   3. No tracked file assigns a plausible secret to a name that looks like a
//      credential, unless the value is an obvious placeholder.
//
// The third check is the one that catches the common case: a real value pasted
// into a config file or a test fixture. It leans on a placeholder allowlist
// rather than a secret allowlist, so a genuinely new secret is caught by default
// and a false positive has to be argued for explicitly.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const selfPath = resolve(fileURLToPath(import.meta.url));
const root = join(dirname(selfPath), "..");

// Values that are documentation, not credentials. Matched case-insensitively
// against the whole value.
//
// The slug and short-hex rules are deliberately narrow. An earlier version
// allowed any bare `[a-z0-9-]+`, which also matches a hex API key, so a real
// credential of that shape passed the gate; the self-test caught it.
const PLACEHOLDER = new RegExp(
  [
    "^$", // empty
    "^(your|my|the|insert|replace)[-_ ]",
    "^<.*>$", // <id>
    "\\$\\{",
    "changeme",
    "placeholder",
    "example",
    "sample",
    "redacted",
    "dummy",
    "fake",
    "not[-_ ]?a[-_ ]?real",
    "todo",
    "fixme",
    "none",
    "null",
    "undefined",
    "xxxx",
    // A kebab slug, as used for profile ids, country codes, and option names.
    `^[a-z0-9]+(?:-[a-z0-9]+)+$`,
    // A short hex run, which is a port or a small id rather than a key.
    "^[0-9a-f]{1,15}$",
    "^(true|false|\\d+)$",
  ].join("|"),
  "i",
);

// Credential shapes we have actually seen in this project's providers.
const PROVIDER_PATTERNS = [
  {
    id: "telnyx-api-key",
    // KEY01A0B61E37B1C37A00D9108228E8D9E3_RQI1dMF7hFB43gPvzZ0A0p
    regex: /\bKEY[0-9A-Fa-f]{12,}_[A-Za-z0-9_-]{16,}\b/g,
  },
  { id: "telnyx-webhook-token", regex: /\bNE4_[A-Za-z0-9_-]{20,}\b/g },
  { id: "clerk-key", regex: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g },
  {
    id: "json-web-token",
    // A Twenty API key is a signed JWT.
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  { id: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { id: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-live-key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  {
    id: "database-url-with-password",
    // postgres://user:password@host, which is how a connection string leaks.
    regex: /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^:/\s]+:[^@\s]{3,}@/g,
  },
];

// Values that are fixed by a specification, so they carry no entropy and cannot
// be leaked. These are vocabulary, not placeholders: a placeholder is something
// a human chose to stand in for a real value, whereas these are the literal
// words the protocol requires on the wire. The allowlist is deliberately short
// and each entry names the rule that fixes it, so adding one is a decision
// rather than a reflex.
const PROTOCOL_CONSTANTS = new Set([
  // RFC 7591 dynamic client registration.
  "client_secret_post",
  "client_secret_basic",
  "authorization_code",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
]);

// A name that makes the value on the right a credential.
const SECRET_NAME = String.raw`(?:api[_-]?key|apikey|secret|pass(?:word|wd)?|token|private[_-]?key|client[_-]?secret|webhook[_-]?token)`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*)\s*[:=]\s*["']([^"'\n]{8,})["']`,
  "gi",
);

// Files that must never be tracked. Env files are matched on the basename so a
// nested `apps/api/.env.local` is caught too, and every `.env.<suffix>` is
// forbidden except the documented templates, so a new name like `.env.leak`
// cannot slip past a list of known ones.
const ENV_TEMPLATE = /\.(example|template|sample)$/i;
const FORBIDDEN_FILES = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$|template$|sample$)/,
  /(^|\/)\.env\.[^/]*\.(?!example$|template$|sample$)[^/]*$/,
  /\.(pem|p12|pfx)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)credentials?\.json$/,
  /(^|\/)service-account.*\.json$/,
  /(^|\/)temp_login\.json$/,
];

function isForbiddenFile(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (/^\.env(\..+)?$/.test(base) && !ENV_TEMPLATE.test(base)) return true;
  return FORBIDDEN_FILES.some((pattern) => pattern.test(rel));
}

const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|mdx|txt|env|example|sh|toml|ini|cfg|sql|sh)$/i;

/** Files the scan reads, which is exactly the push set. */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    // Without git the gate cannot know what would be pushed, so it must not
    // pass silently.
    console.error("check-no-secrets: could not list tracked files with git ls-files.");
    process.exit(1);
  }
}

function scanText(relPath, text) {
  const found = [];
  for (const { id, regex } of PROVIDER_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      found.push({ relPath, line: lineOf(text, match.index ?? 0), id, match: match[0] });
    }
  }
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    const value = match[2] ?? "";
    if (PROTOCOL_CONSTANTS.has(value.trim())) continue;
    if (PLACEHOLDER.test(value.trim())) continue;
    found.push({ relPath, line: lineOf(text, match.index ?? 0), id: "secret-assignment", match: value });
  }
  return found;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Show enough to recognise the value and little enough to be safe in a log. */
function redact(value) {
  return value.length <= 8 ? "*".repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function run() {
  const violations = [];
  const files = trackedFiles();

  for (const rel of files) {
    if (rel === relative(root, selfPath).replace(/\\/g, "/")) continue;

    if (isForbiddenFile(rel)) {
      violations.push(`${rel}: forbidden file is tracked. Credentials belong in .env.local, which is ignored.`);
      continue;
    }
    if (!SCAN_EXT.test(rel)) continue;

    const abs = join(root, rel);
    let text;
    try {
      if (statSync(abs).size > 4 * 1024 * 1024) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // A NUL means binary, whatever the extension claims.
    if (text.includes("\0")) continue;

    violations.push(...scanText(rel, text));
  }

  if (violations.length > 0) {
    console.error("check-no-secrets: FAIL — credentials must not be committed:");
    for (const violation of violations) {
      if (typeof violation === "string") {
        console.error(`  - ${violation}`);
      } else {
        console.error(
          `  - ${violation.relPath}:${violation.line}: looks like ${violation.id} (${redact(violation.match)})`,
        );
      }
    }
    console.error(
      "\nIf this is a false positive, make the value an obvious placeholder rather than allowlisting it.",
    );
    process.exit(1);
  }

  console.log(`check-no-secrets: OK — ${files.length} tracked files, no credentials.`);
}

/**
 * Self-test. Writes known-bad and known-good fixtures to a temporary directory
 * and checks the scanner separates them, so the gate is not trusted on trust.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "blaster-secret-scan-"));
  let failures = 0;
  try {
    const cases = [
      { name: "good.env", text: "TWENTY_BASE_URL=https://twenty.example.com\nTELNYX_API_KEY=\nPORT=4180\n", expect: 0 },
      { name: "good.json", text: '{"apiKey":"your-twenty-api-key-here","secret":"changeme"}', expect: 0 },
      { name: "good.md", text: "Set `TELNYX_API_KEY` and use `TELNYX_MESSAGING_PROFILES=US=<id>`.", expect: 0 },
      { name: "bad-telnyx.txt", text: "TELNYX_API_KEY=KEY01A0B61E37B1C37A00D9108228E8D9E3_RQI1dMF7hFB43gPvzZ0A0p\n", expect: 1 },
      { name: "bad-clerk.txt", text: 'const key = "sk_test_abcdefghij1234567890ABCD";\n', expect: 1 },
      { name: "bad-assign.txt", text: 'const twentyApiKey = "8f2b91c4d7e0a3567b1c9e4f0d2a8b3c";\n', expect: 1 },
      { name: "bad-db.txt", text: "TWENTY_DATABASE_URL=postgres://dialer_ro:sup3rs3cret@node01:5432/twenty\n", expect: 1 },
    ];

    for (const testCase of cases) {
      const abs = join(dir, testCase.name);
      writeFileSync(abs, testCase.text, "utf8");
      const found = scanText(testCase.name, testCase.text);
      const got = found.length > 0 ? 1 : 0;
      if (got !== testCase.expect) {
        failures += 1;
        console.error(
          `  self-test FAILED  ${testCase.name}: expected ${testCase.expect === 1 ? "a match" : "no match"}, got ${got}` +
            (found.length > 0 ? ` (${found.map((f) => f.id).join(", ")})` : ""),
        );
      } else {
        console.log(`  self-test ok      ${testCase.name.padEnd(18)} ${testCase.expect === 1 ? "flagged" : "allowed"}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`check-no-secrets: self-test failed with ${failures} bad case(s).`);
    process.exit(1);
  }
  console.log("check-no-secrets: self-test OK");
}

if (process.argv.includes("--self-test")) selfTest();
else run();
