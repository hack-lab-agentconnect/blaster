// Gate: the generated Twenty client must be complete on disk.
//
// The client is the only description of the workspace schema we have, and it is
// large: `schema.ts` and `types.ts` are megabytes each. That size is exactly why
// it went missing once and nothing noticed — a tooling pass dropped the two big
// files, the tree stayed type-correct because the small ones still imported them
// by path, and the failure only surfaced as a module-not-found when Bun tried to
// load the client.
//
// So the invariant is checked directly rather than inferred: the files exist,
// they are not stubs, and the schema actually contains the custom objects the
// product reads. Run by lefthook (see lefthook.yml) and by `pnpm check`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(root, "packages/core/src/twenty/graphql/generated");

/** Every file the generator emits, with a floor well below its real size. */
const EXPECTED = [
  ["index.ts", 1_000],
  ["schema.ts", 1_000_000],
  ["types.ts", 1_000_000],
  ["runtime/index.ts", 300],
  ["runtime/createClient.ts", 800],
  ["runtime/batcher.ts", 4_000],
  ["runtime/error.ts", 300],
  ["runtime/fetcher.ts", 1_500],
  ["runtime/generateGraphqlOperation.ts", 3_000],
  ["runtime/linkTypeMap.ts", 2_500],
  ["runtime/types.ts", 800],
  ["runtime/typeSelection.ts", 1_500],
];

/**
 * Custom objects the product depends on. Their absence from the schema means the
 * client was generated against a different workspace, which would compile
 * cleanly and then fail at the first query.
 */
const REQUIRED_TYPES = [
  "AgencyPhones",
  "AgencyPhoneConnection",
  "AgencyLeads",
  "AgencyCalls",
];

const violations = [];

if (!existsSync(GENERATED)) {
  console.error(
    "check-generated-client: FAIL — the generated Twenty client is absent.\n" +
      "Regenerate with: TWENTY_BASE_URL=... TWENTY_API_KEY=... pnpm twenty:client",
  );
  process.exit(1);
}

for (const [name, minBytes] of EXPECTED) {
  const path = join(GENERATED, name);
  if (!existsSync(path)) {
    violations.push(`${name} is missing`);
    continue;
  }
  const { size } = statSync(path);
  if (size < minBytes) {
    violations.push(`${name} is ${size} bytes, expected at least ${minBytes} — it looks truncated`);
  }
  const text = readFileSync(path, "utf8");
  if (!/^\s*\/\/\s*@generated\b/m.test(text)) {
    violations.push(`${name} has no @generated header, so the brand gates will scan it as hand-written`);
  }
}

if (existsSync(join(GENERATED, "schema.ts"))) {
  const schema = readFileSync(join(GENERATED, "schema.ts"), "utf8");
  for (const type of REQUIRED_TYPES) {
    if (!schema.includes(type)) {
      violations.push(
        `schema.ts has no ${type}. The client was generated from a workspace without the ` +
          `custom objects, or from a stale introspection.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("check-generated-client: FAIL — the generated Twenty client is not usable:");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nRegenerate with: TWENTY_BASE_URL=... TWENTY_API_KEY=... pnpm twenty:client\n" +
      `Path: ${relative(root, GENERATED).replace(/\\/g, "/")}`,
  );
  process.exit(1);
}

console.log(
  `check-generated-client: OK — ${EXPECTED.length} files, schema carries the custom objects.`,
);
