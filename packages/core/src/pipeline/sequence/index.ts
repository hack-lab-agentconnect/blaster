export * from "./helpers/index.ts";

// Types must be re-exported with `export type`. esbuild cannot tell a type from
// a value in a re-export clause, so it preserves the name and the ESM loader
// rejects it at runtime ("does not provide an export named ..."). tsc elides
// these, so typecheck passes while the server does not boot. Same rule and same
// reason as conversation/classification/index.ts.
export type {
  EligibilityEvaluator,
  EligibilityInput,
  EnrollmentEvent,
  EnrollmentMachineInput,
  EnrollmentStatus,
  NextAllowedSendAt,
  SequenceEffect,
} from "./types.ts";
export { MAX_STEP_ATTEMPTS, RETRY_BACKOFF_MS, SKIP_RETRY_MS, claimKeyFor } from "./types.ts";
export { createEnrollmentMachine } from "./machine.ts";
export type { EnrollmentMachine } from "./machine.ts";
