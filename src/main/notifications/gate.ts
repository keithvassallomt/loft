export interface NotifyDecisionInput {
  systemDnd: boolean;
  globalDnd: boolean;
  serviceDnd: boolean;
  focused: boolean;
  visible: boolean;
  /** Is this the service the user is actually looking at? Always true for a service
   *  with its own window; for a shared host, true only for the selected tab. */
  active: boolean;
}

/**
 * Show a notification only when no DND flag is set and the user is not already
 * looking at this service.
 *
 * "Looking at it" needs all three: the window focused, the window visible, AND this
 * service being the active tab. Before the Loft window, active was implicitly always
 * true (one service per window) and focused+visible was the whole test. In a shared
 * host every attached service is focused+visible at once, so without `active` every
 * background tab goes silent.
 */
export function shouldNotify(i: NotifyDecisionInput): boolean {
  if (i.systemDnd || i.globalDnd || i.serviceDnd) return false;
  if (isWatching(i)) return false;
  return true;
}

/**
 * Is the user actually looking at this service right now?
 *
 * Extracted because a second caller needs it: bubbles treat the open conversation as read,
 * and that is only true while someone is looking. A conversation left open in a BACKGROUND
 * service is not being read by anyone — open a pinned chat, switch to another service, and a
 * message arriving in that chat would otherwise clear its own unread dot.
 *
 * Deliberately NOT `!shouldNotify`: a service on Do Not Disturb is still being READ when you
 * are looking at it. DND silences notifications; it does not blind the user.
 */
export function isWatching(i: Pick<NotifyDecisionInput, 'focused' | 'visible' | 'active'>): boolean {
  return i.focused && i.visible && i.active;
}

export class NotificationGate {
  private _systemDnd = false;
  private _globalDnd = false;
  private serviceDnd = new Map<string, boolean>();
  private focused = new Map<string, boolean>();
  private visible = new Map<string, boolean>();
  private active = new Map<string, boolean>();

  setSystemDnd(v: boolean): void { this._systemDnd = v; }
  setGlobalDnd(v: boolean): void { this._globalDnd = v; }
  setServiceDnd(id: string, v: boolean): void { this.serviceDnd.set(id, v); }
  setFocused(id: string, v: boolean): void { this.focused.set(id, v); }
  setVisible(id: string, v: boolean): void { this.visible.set(id, v); }
  setActive(id: string, v: boolean): void { this.active.set(id, v); }

  get systemDnd(): boolean { return this._systemDnd; }
  get globalDnd(): boolean { return this._globalDnd; }

  /** System OR global OR this service's DND — what the view is told to suppress on. */
  effectiveDnd(id: string): boolean {
    return this._systemDnd || this._globalDnd || (this.serviceDnd.get(id) ?? false);
  }

  /** See the free function above. Defaults to false: a service nothing has reported on is
   *  not being watched, which is the safe answer for both callers. */
  isWatching(id: string): boolean {
    return isWatching({
      focused: this.focused.get(id) ?? false,
      visible: this.visible.get(id) ?? false,
      active: this.active.get(id) ?? true,
    });
  }

  shouldNotify(id: string): boolean {
    return shouldNotify({
      systemDnd: this._systemDnd,
      globalDnd: this._globalDnd,
      serviceDnd: this.serviceDnd.get(id) ?? false,
      focused: this.focused.get(id) ?? false,
      visible: this.visible.get(id) ?? false,
      active: this.active.get(id) ?? true,
    });
  }
}
