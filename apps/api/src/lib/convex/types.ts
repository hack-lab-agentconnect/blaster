/**
 * Results of writing to Convex, as the HTTP surface reports them.
 *
 * The webhook maps these straight onto status codes, so the names here are the
 * vocabulary the route reasons in rather than Convex's internals.
 */

export type {
  ConversationQuery,
  ConversationRow,
  InboundRecordInput,
  InboundRecordResult,
  MessageRow,
  PoolResult,
  ReadResult,
  StatusResult,
} from "./helpers/client.ts";
