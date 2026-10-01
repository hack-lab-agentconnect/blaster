/**
 * Telling a human that a prospect answered.
 *
 * A reply is the one event in a sequence that a person wants to know about
 * immediately, because it is the moment the automation is supposed to get out of
 * the way. So it both stops the enrollment and raises a push.
 *
 * Three properties are carried over from the dialer's new-lead broadcast, which
 * was the first place Blaster needed one:
 *
 *   - **One fan-out point per event.** There is more than one path to the same
 *     event, and every path has to come through here or the two disagree about
 *     what was notified. Here, the path is the verified Telnyx webhook, and the
 *     duplicate case is a Telnyx redelivery.
 *   - **Notification never fails the event.** Every outcome is counted and
 *     returned; nothing throws. A reply that was stored and stopped a sequence is
 *     worth far more than the push that said so, and a Bark outage must not
 *     become a 500 on a webhook Telnyx will retry three times.
 *   - **A member with no key is skipped, not failed.** Not everyone has
 *     configured one, and that is a configuration state rather than an error.
 *
 * The dedupe is not here: it is the `providerEventId` check inside
 * `recordInboundMessage`, which returns before this is ever called for a
 * redelivery. That is why the caller is told what stopped, rather than this
 * module deciding whether it has seen a message before.
 */

import { sendBarkPush, type BarkBroadcastResult, type BarkPushResult } from "../../bark/index.ts";
import { listWorkspaceMembers, type WorkspaceMemberRecord } from "../../twenty/workspaceMember/index.ts";
import type { TwentyClient } from "../../twenty/client/index.ts";

export interface ReplyNotification {
  /** The prospect's number, E.164. */
  peer: string;
  /** What they said, already truncated by the caller. */
  preview: string;
  /** How many sequences this reply just stopped. Zero means it was already stopped. */
  stoppedCount: number;
  /**
   * The responsible members, taken from the stopped enrollments' owner fields.
   * When present and non-empty, only these members are notified; otherwise the
   * fan-out falls back to every member with a key. The routing lives in the
   * record, not outside the workflow.
   */
  targetMemberIds?: string[];
  /** A link back to the thread, so the tap lands somewhere useful. */
  url?: string;
}

export interface NotifyResult extends BarkBroadcastResult {
  /** Per-member outcomes, so a caller can log a failure without re-sending. */
  outcomes: Array<{ memberId: string; result: BarkPushResult }>;
  /** True when the member list could not be read at all. */
  aborted: boolean;
}

/** The push text. Short on purpose: it is read on a lock screen. */
export function formatReplyBody(notification: ReplyNotification): string {
  const stopped =
    notification.stoppedCount > 0
      ? `Stopped ${notification.stoppedCount} sequence step(s).`
      : "No active sequence.";
  return `${notification.peer}: ${notification.preview}\n${stopped}`;
}

/**
 * Push a reply notification to every member with a Bark key.
 *
 * Fire-and-forget by contract: this resolves with counts, never throws, and a
 * failed lookup returns `aborted` rather than an exception so a Twenty outage
 * cannot surface as a webhook failure.
 */
export async function broadcastReply(
  client: TwentyClient,
  notification: ReplyNotification,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<NotifyResult> {
  const result: NotifyResult = {
    attempted: 0,
    sent: 0,
    skippedNoKey: 0,
    failed: 0,
    outcomes: [],
    aborted: false,
  };

  let members: WorkspaceMemberRecord[];
  try {
    members = await listWorkspaceMembers(client);
  } catch {
    // A notification that cannot even address its recipients is abandoned, not
    // retried by the caller: the reply itself is already stored.
    result.aborted = true;
    return result;
  }

  const targets = new Set(notification.targetMemberIds ?? []);
  const addressed =
    targets.size > 0 ? members.filter((member) => targets.has(member.id)) : members;
  const withKey = addressed.filter((member) => Boolean(member.barkKey));
  result.skippedNoKey = members.length - withKey.length;
  if (withKey.length === 0) return result;

  const body = formatReplyBody(notification);
  const settled = await Promise.allSettled(
    withKey.map((member) =>
      sendBarkPush(
        member.barkKey as string,
        {
          title: "Prospect replied",
          body,
          group: "replies",
          ...(notification.url ? { url: notification.url } : {}),
          // A reply is time-sensitive by nature: a human is waiting on it and
          // every further step is one they will have to apologise for.
          level: "timeSensitive",
        },
        env,
        fetchFn,
      ),
    ),
  );

  result.attempted = withKey.length;
  settled.forEach((outcome, index) => {
    const member = withKey[index] as WorkspaceMemberRecord;
    if (outcome.status === "fulfilled" && outcome.value.ok) {
      result.sent += 1;
      result.outcomes.push({ memberId: member.id, result: outcome.value });
      return;
    }
    result.failed += 1;
    result.outcomes.push({
      memberId: member.id,
      result:
        outcome.status === "fulfilled"
          ? outcome.value
          : { ok: false, status: 0, message: String(outcome.reason) },
    });
  });
  return result;
}
