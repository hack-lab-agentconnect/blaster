/**
 * The sequence domain's interface.
 *
 * Types and validators only — never functions. A Convex function is addressed by
 * its module path, so re-exporting one through a barrel would give it a second
 * address (F3, R9). Consumers that need a validator or a type import from here;
 * anything calling a function imports `queries.ts` / `mutations.ts` /
 * `actions.ts` directly.
 */
export {
  applyScheduleArgsValidator,
  claimStepArgsValidator,
  completeEnrollmentArgsValidator,
  enrollmentStatusValidator,
  scheduledStatusValidator,
  sentMessageValidator,
  stepFieldsValidator,
  stepOutcomeValidator,
} from "./types.js";
export type {
  ActiveStatus,
  ApplyScheduleArgs,
  ApplyScheduleResult,
  AssertScheduledStatusMatches,
  AssertStatusMatchesCore,
  ClaimResult,
  ClaimStepArgs,
  CompleteEnrollmentArgs,
  CompleteEnrollmentResult,
  EnrollmentStatus,
  EnrollArgs,
  ParkedStatus,
  ProfilePair,
  RecordedStepResult,
  RecordStepArgs,
  RunContext,
  RunOutcome,
  ScheduledStatus,
  SentMessage,
  StepFields,
  StepOutcome,
  StopStatus,
} from "./types.js";
