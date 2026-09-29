// Gate: no file may be double-encoded, and none may carry a byte-order mark.
//
// Both defects are invisible to review, which is why they need a gate.
//
// Mojibake: a UTF-8 file read as Windows-1252 and written back as UTF-8 turns
// one em dash into three characters, and the result is still perfectly valid
// UTF-8. Nothing else in this repository can catch it — the emoji gate looks
// for pictographs, and the secret gate looks for credentials. It reached a
// commit once already, in four files, and it is the kind of corruption that
// makes prose look machine-written to the person reading it.
//
// Byte-order marks: a BOM is invisible in most editors, breaks a shebang
// outright (`bin` entries stop executing), and shows up as a whole changed
// first line in every diff that touches the file.
//
// Run by lefthook and by `pnpm check`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const BOM = [0xef, 0xbb, 0xbf];

/**
 * The tell-tale sequences of a double-encoded UTF-8 string.
 *
 * `â€` is what an em dash (E2 80 94) becomes, `â€¦` an ellipsis, `Â·` a
 * middot. The middle sign of a real euro character is also a strong hint, so it
 * is only reported next to a leading Â/Ã/â to avoid flagging genuine prose about
 * prices.
 */
const MOJIBAKE = /[ÂÃâ]\u0080|â€|Â·|â€™|â€œ|â€\x9d|â€“|â€”|Ã©|Ã¨/;

/** Files the push set contains, which is the same source the secret gate uses. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/** Binary-ish extensions the scan skips, because decoding them proves nothing. */
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp3|mp4|wasm|lock)$/i;

const violations = [];
let scanned = 0;

for (const file of trackedFiles()) {
  if (SKIP_EXT.test(file)) continue;
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  scanned += 1;

  if (bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    const body = bytes.subarray(3);
    violations.push({
      file,
      kind: "byte-order mark",
      detail:
        body.subarray(0, 2).toString("utf8") === "#!"
          ? "BOM before a shebang: this file will not execute as a bin entry"
          : "strip the BOM",
    });
  }

  const text = bytes.toString("utf8");
  const match = MOJIBAKE.exec(text);
  if (match) {
    violations.push({
      file,
      kind: "double-encoded text",
      detail: `line ${text.slice(0, match.index).split("\n").length} contains ${JSON.stringify(match[0])}`,
    });
  }
}

if (violations.length > 0) {
  console.error("check-encoding: FAIL — files are not clean UTF-8:");
  for (const v of violations) {
    console.error(`  - ${v.file}: ${v.kind}, ${v.detail}`);
  }
  console.error(
    "\nA file was read as Windows-1252 and written back as UTF-8. Repair the text,\n" +
      "and edit UTF-8 files with a UTF-8 aware editor rather than a shell redirect.",
  );
  process.exit(1);
}

console.log(`check-encoding: OK — ${scanned} tracked files, no BOMs and no double-encoded text.`);
void relative;
