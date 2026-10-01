/**
 * Sequence drafts on the operator's own machine.
 *
 * `.blaster/sequences.json`, next to the session file and gitignored with it.
 * This lives in the CLI rather than in core deliberately: the operator's draft
 * is terminal-local working material, the way a session file is, and unlike the
 * session there is nothing another surface needs to read it. A draft becomes
 * real when it is handed to the runner, and that is where it is validated.
 *
 * Every function takes a `root` so a test can point it at a temporary directory
 * instead of the working directory, and a corrupt or unreadable file reads as
 * "no drafts" rather than throwing: a damaged file should not stop an operator
 * from running the other commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OPTIONS, type SequenceDraft, type SequenceStepDraft } from "@blaster/core";

const DRAFT_DIR = ".blaster";
const DRAFT_FILE = "sequences.json";

export interface StoredDraft {
  draft: SequenceDraft;
  createdAt: string;
  updatedAt: string;
}

interface DraftFile {
  version: 1;
  drafts: StoredDraft[];
}

const draftPath = (root: string): string => join(root, DRAFT_DIR, DRAFT_FILE);

/**
 * Coerce whatever is on disk into a draft.
 *
 * A file can outlive the code that wrote it, so every field is defaulted rather
 * than trusted: a draft missing `options` still opens, and one with a malformed
 * step is dropped rather than crashing the whole list.
 */
function toDraft(raw: unknown): SequenceDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<SequenceDraft> & { options?: Partial<SequenceDraft["options"]> };
  if (typeof value.name !== "string") return null;
  const steps: SequenceStepDraft[] = Array.isArray(value.steps)
    ? value.steps
        .map((step) => {
          const s = (step ?? {}) as Partial<SequenceStepDraft>;
          return {
            text: typeof s.text === "string" ? s.text : "",
            delayHours: typeof s.delayHours === "number" ? s.delayHours : 0,
            isStop: s.isStop === true,
          };
        })
        .filter((step) => step.text.length > 0 || step.isStop)
    : [];
  return {
    name: value.name,
    fromNumber: typeof value.fromNumber === "string" ? value.fromNumber : "",
    numberProfileId: typeof value.numberProfileId === "string" ? value.numberProfileId : undefined,
    campaignId: typeof value.campaignId === "string" ? value.campaignId : undefined,
    // Defaults are the safe ones: stop on reply, respect do-not-contact, and
    // require a profile for the country. An older file cannot have opted out of
    // anything, which is the correct direction for a default to fail.
    options: { ...DEFAULT_OPTIONS, ...(value.options ?? {}) },
    steps,
  };
}

export function readDrafts(root: string): StoredDraft[] {
  const path = draftPath(root);
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DraftFile>;
    if (!Array.isArray(parsed.drafts)) return [];
    const out: StoredDraft[] = [];
    for (const entry of parsed.drafts) {
      const draft = toDraft((entry as Partial<StoredDraft>)?.draft);
      if (!draft) continue;
      out.push({
        draft,
        createdAt: (entry as Partial<StoredDraft>)?.createdAt ?? "",
        updatedAt: (entry as Partial<StoredDraft>)?.updatedAt ?? "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeDrafts(root: string, drafts: StoredDraft[]): void {
  const dir = join(root, DRAFT_DIR);
  mkdirSync(dir, { recursive: true });
  const body: DraftFile = { version: 1, drafts };
  writeFileSync(draftPath(root), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function findDraft(root: string, name: string): StoredDraft | null {
  const wanted = name.trim().toLowerCase();
  return readDrafts(root).find((entry) => entry.draft.name.trim().toLowerCase() === wanted) ?? null;
}

/** Insert or replace by name, returning whether this was a new draft. */
export function saveDraft(root: string, draft: SequenceDraft, now: string): boolean {
  const drafts = readDrafts(root);
  const wanted = draft.name.trim().toLowerCase();
  const existing = drafts.findIndex(
    (entry) => entry.draft.name.trim().toLowerCase() === wanted,
  );
  if (existing >= 0) {
    const previous = drafts[existing] as StoredDraft;
    drafts[existing] = {
      draft,
      createdAt: previous.createdAt || now,
      updatedAt: now,
    };
  } else {
    drafts.push({ draft, createdAt: now, updatedAt: now });
  }
  writeDrafts(root, drafts);
  return existing < 0;
}

export function deleteDraft(root: string, name: string): boolean {
  const drafts = readDrafts(root);
  const wanted = name.trim().toLowerCase();
  const next = drafts.filter((entry) => entry.draft.name.trim().toLowerCase() !== wanted);
  if (next.length === drafts.length) return false;
  writeDrafts(root, next);
  return true;
}

export const DRAFT_FILE_PATH_SUFFIX = join(DRAFT_DIR, DRAFT_FILE);
