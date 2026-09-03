/**
 * What a service's page reports about its own liveness, in answer to a `service:health-ping`.
 *
 * Deliberately app-AGNOSTIC. The obvious alternative — scraping each web app's own
 * "Reconnecting…" banner — rots silently: a class name changes, the parser stops matching,
 * and the monitor quietly decides every service is healthy forever. Nothing here depends on
 * a selector, a string, or anything the six web apps can rename.
 */
export interface HealthSnapshot {
  /**
   * Milliseconds since the page last RECEIVED data from the network — a WebSocket message
   * or any resource-timing entry (fetch/XHR/long-poll/image). `null` means nothing has ever
   * arrived since the page loaded.
   *
   * This is the whole liveness signal. Every service Loft hosts is a messaging app holding a
   * live connection: keepalives, presence, or a /sync long-poll all land here at least once
   * a minute or two. Silence for materially longer than that means the connection is gone,
   * whatever the UI says.
   */
  lastActivityMs: number | null;
  /** WebSockets currently open. Diagnostics only — the decision runs off activity. */
  openSockets: number;
  /** Has this page ever opened a WebSocket? Diagnostics only. */
  everHadSockets: boolean;
  /** Milliseconds since this document loaded. A page that just loaded is never judged stale. */
  uptimeMs: number;
  /**
   * Is the user part-way through typing? True when the focused element is a non-empty
   * input/textarea/contenteditable.
   *
   * The one thing a reload genuinely destroys. Everything else a reload costs (scroll
   * position, which chat is open) comes back in seconds; a half-written message does not.
   */
  hasDraft: boolean;
  /** The page's own `navigator.onLine`. Diagnostics — main gates on Chromium's net state. */
  online: boolean;
}
