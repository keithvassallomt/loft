/**
 * Retry schedule shared by the D-Bus clients that can lose a race at login.
 *
 * A session bus name Loft depends on may simply not be owned yet when Loft starts: the
 * autostart entry fires alongside the desktop shell, not after it, and a shell that restarts
 * itself a beat later (Caelestia/quickshell does exactly this under uwsm) reopens the gap.
 * A single attempt that fails and is never retried disables the feature for the whole
 * session, silently — which is what one-shot `getProxyObject` calls buy you.
 *
 * [0,2,4,8,16]s, holding at the max, is the schedule ksni proved for StatusNotifierWatcher.
 */
export const DBUS_BACKOFF_SECONDS = [0, 2, 4, 8, 16] as const;

/** Retry delay (seconds) for the Nth attempt; holds at the maximum. */
export function nextBackoff(attempt: number): number {
  return DBUS_BACKOFF_SECONDS[Math.min(attempt, DBUS_BACKOFF_SECONDS.length - 1)];
}
