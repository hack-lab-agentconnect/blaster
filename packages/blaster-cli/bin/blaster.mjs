#!/usr/bin/env node
/**
 * argv in, exit code out.
 *
 * The CLI is TypeScript and this repository runs from source — `noEmit` in every
 * tsconfig, tsx for the API, vitest for tests — so the bin entry registers a
 * TypeScript loader and imports the real entry point rather than shipping a
 * compiled copy. The alternative is a build step that would have to run before
 * the CLI works, which is a worse trade for a private workspace package.
 *
 * In-process rather than spawning `tsx src/cli/index.ts` as a child, because
 * `blaster login` serves a loopback on 127.0.0.1 and opens a browser: a child
 * process would interpose on stdin and Ctrl-C, which is exactly the moment when
 * an operator is waiting on a redirect and needs to be able to abort.
 *
 * The CLI reads its session from `.blaster/` in the working directory, so this
 * must be run from the project you mean rather than from wherever it is
 * installed.
 */

// `register()` is a named import from the package export map, so a version that
// moves it fails loudly here instead of silently running an unhandled .ts file.
import { register } from "tsx/esm/api";

register();

// No credentials are read here. The CLI holds no Telnyx key and no Twenty
// token: it authenticates to the API with the operator session from
// `blaster login`, and the API is the only process that holds provider secrets.
// A CLI that loaded its own .env would be a second, divergent copy of the send
// path, which is the thing this command exists to avoid.
await import("../src/cli/index.ts");
