/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as blaster_mutations from "../blaster/mutations.js";
import type * as blaster_queries from "../blaster/queries.js";
import type * as conversations_model from "../conversations/model.js";
import type * as conversations_mutations from "../conversations/mutations.js";
import type * as conversations_queries from "../conversations/queries.js";
import type * as http from "../http.js";
import type * as http_blaster from "../http/blaster.js";
import type * as phoneNumbers_actions from "../phoneNumbers/actions.js";
import type * as phoneNumbers_model from "../phoneNumbers/model.js";
import type * as phoneNumbers_mutations from "../phoneNumbers/mutations.js";
import type * as phoneNumbers_queries from "../phoneNumbers/queries.js";
import type * as pool_helpers from "../pool/helpers.js";
import type * as pool_index from "../pool/index.js";
import type * as pool_model from "../pool/model.js";
import type * as pool_mutations from "../pool/mutations.js";
import type * as pool_queries from "../pool/queries.js";
import type * as pool_types from "../pool/types.js";
import type * as schema_conversations from "../schema/conversations.js";
import type * as schema_discovery from "../schema/discovery.js";
import type * as schema_messaging from "../schema/messaging.js";
import type * as schema_phone from "../schema/phone.js";
import type * as schema_pool from "../schema/pool.js";
import type * as schema_sequences from "../schema/sequences.js";
import type * as sequence_actions from "../sequence/actions.js";
import type * as sequence_helpers from "../sequence/helpers.js";
import type * as sequence_index from "../sequence/index.js";
import type * as sequence_model from "../sequence/model.js";
import type * as sequence_mutations from "../sequence/mutations.js";
import type * as sequence_queries from "../sequence/queries.js";
import type * as sequence_types from "../sequence/types.js";
import type * as sequence_utils from "../sequence/utils.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "blaster/mutations": typeof blaster_mutations;
  "blaster/queries": typeof blaster_queries;
  "conversations/model": typeof conversations_model;
  "conversations/mutations": typeof conversations_mutations;
  "conversations/queries": typeof conversations_queries;
  http: typeof http;
  "http/blaster": typeof http_blaster;
  "phoneNumbers/actions": typeof phoneNumbers_actions;
  "phoneNumbers/model": typeof phoneNumbers_model;
  "phoneNumbers/mutations": typeof phoneNumbers_mutations;
  "phoneNumbers/queries": typeof phoneNumbers_queries;
  "pool/helpers": typeof pool_helpers;
  "pool/index": typeof pool_index;
  "pool/model": typeof pool_model;
  "pool/mutations": typeof pool_mutations;
  "pool/queries": typeof pool_queries;
  "pool/types": typeof pool_types;
  "schema/conversations": typeof schema_conversations;
  "schema/discovery": typeof schema_discovery;
  "schema/messaging": typeof schema_messaging;
  "schema/phone": typeof schema_phone;
  "schema/pool": typeof schema_pool;
  "schema/sequences": typeof schema_sequences;
  "sequence/actions": typeof sequence_actions;
  "sequence/helpers": typeof sequence_helpers;
  "sequence/index": typeof sequence_index;
  "sequence/model": typeof sequence_model;
  "sequence/mutations": typeof sequence_mutations;
  "sequence/queries": typeof sequence_queries;
  "sequence/types": typeof sequence_types;
  "sequence/utils": typeof sequence_utils;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
