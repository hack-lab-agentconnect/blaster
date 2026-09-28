/**
 * The environment manifest, read from config/env-vars.json.
 *
 * The manifest is the contract: the API, the Convex backend, and the docs all
 * read it rather than each keeping their own list. A variable that no surface
 * consumes, or a surface reading a variable the manifest does not declare, is a
 * drift this makes visible.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnvVar {
  name: string;
  consumedBy: string[];
  required: boolean;
  secret: boolean;
  description: string;
}

export interface EnvManifest {
  description: string;
  vars: EnvVar[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file until config/env-vars.json is found. */
function findManifestPath(): string {
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "config", "env-vars.json");
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("config/env-vars.json not found");
}

let cached: EnvManifest | null = null;

export function readEnvManifest(): EnvManifest {
  if (!cached) {
    cached = JSON.parse(readFileSync(findManifestPath(), "utf8")) as EnvManifest;
  }
  return cached;
}

export function describeEnv(): Array<EnvVar & { configured: boolean }> {
  const manifest = readEnvManifest();
  return manifest.vars.map((variable) => ({
    ...variable,
    configured: Boolean(process.env[variable.name]),
  }));
}

/**
 * Which required variables are unset. A named required variable is a
 * configuration error the caller should surface, rather than a request that
 * fails later with a provider error nobody can act on.
 */
export function missingRequired(env: NodeJS.ProcessEnv = process.env): string[] {
  return readEnvManifest().vars
    .filter((variable) => variable.required && !env[variable.name])
    .map((variable) => variable.name);
}
