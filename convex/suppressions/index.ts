/**
 * The suppression domain's interface.
 *
 * Types and validators only — never functions, which are addressed by path
 * (F3/R9). A consumer imports a validator from here and a function from its own
 * module.
 */
export { liftArgsValidator, suppressArgsValidator, suppressionSourceValidator } from "./types.js";
export type { LiftArgs, SuppressArgs, SuppressionSource } from "./types.js";
