/**
 * A device key safe to put in a message.
 *
 * The key is a credential for the member's device, so it never appears whole in
 * anything a human will read. Enough of each end survives to tell two keys apart
 * when debugging a member who says they are not getting notifications.
 */
export function redactKey(key: string): string {
  const value = (key ?? "").trim();
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
