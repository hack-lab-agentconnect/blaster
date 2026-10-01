/** A push request. Only `body` is required; Bark treats the rest as optional. */
export interface BarkPushOptions {
  title?: string;
  subtitle?: string;
  /** The message itself. */
  body: string;
  /** Collapses this notification with others of the same group on the device. */
  group?: string;
  /** A deep link, so tapping the notification lands on the record. */
  url?: string;
  /**
   * iOS interruption level. `timeSensitive` is the one that breaks through a
   * focus mode, which is the point for something a human is waiting on.
   */
  level?: "active" | "timeSensitive" | "passive" | "critical";
  sound?: string;
  badge?: number;
  icon?: string;
}

export interface BarkPushResult {
  ok: boolean;
  /** The HTTP status, or 0 when the request never completed. */
  status: number;
  message: string;
}

export interface BarkBroadcastResult {
  /** Members with a key, i.e. the pushes actually attempted. */
  attempted: number;
  sent: number;
  /** Members with no key, which is a configuration state rather than a failure. */
  skippedNoKey: number;
  failed: number;
}
