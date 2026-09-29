/**
 * Telnyx messaging for the Hono API.
 *
 * A re-export of @blaster/core's SDK-backed client, so the API surface can
 * never drift from the CLI/MCP surfaces. There is exactly one send path.
 */
export type {
  MessagingProfileSummary,
  SendMessageInput,
  SendMessageResult,
} from "@blaster/core";
export { TelnyxError, listMessagingProfiles, sendMessage, toTelnyxError } from "@blaster/core";
