/**
 * The pool domain's interface.
 *
 * Types and validators only — never functions. A Convex function is addressed by
 * its module path, so re-exporting one through a barrel would give it a second
 * address (F3, R9). Consumers that need a validator import from here; anything
 * calling a function imports `queries.ts` / `mutations.ts` directly.
 */
export {
  assignNumberArgsValidator,
  consumeSenderArgsValidator,
  createPoolArgsValidator,
  poolMemberStatusValidator,
  poolStatusValidator,
  poolStrategyValidator,
  removeNumberArgsValidator,
  reorderNumbersArgsValidator,
  setPoolStatusArgsValidator,
} from "./types.js";
export type {
  AssignNumberArgs,
  ConsumeSenderArgs,
  CreatePoolArgs,
  PoolMemberStatus,
  PoolStatus,
  PoolStrategy,
  RemoveNumberArgs,
  ReorderNumbersArgs,
  SetPoolStatusArgs,
} from "./types.js";
