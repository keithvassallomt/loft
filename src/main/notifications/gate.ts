export interface NotifyDecisionInput {
  systemDnd: boolean;
  globalDnd: boolean;
  serviceDnd: boolean;
  focused: boolean;
  visible: boolean;
}

/** Show a notification only when no DND flag is set and the window is not focused+visible. */
export function shouldNotify(i: NotifyDecisionInput): boolean {
  if (i.systemDnd || i.globalDnd || i.serviceDnd) return false;
  if (i.focused && i.visible) return false;
  return true;
}

export class NotificationGate {
  private _systemDnd = false;
  private _globalDnd = false;
  private serviceDnd = new Map<string, boolean>();
  private focused = new Map<string, boolean>();
  private visible = new Map<string, boolean>();

  setSystemDnd(v: boolean): void { this._systemDnd = v; }
  setGlobalDnd(v: boolean): void { this._globalDnd = v; }
  setServiceDnd(id: string, v: boolean): void { this.serviceDnd.set(id, v); }
  setFocused(id: string, v: boolean): void { this.focused.set(id, v); }
  setVisible(id: string, v: boolean): void { this.visible.set(id, v); }

  get systemDnd(): boolean { return this._systemDnd; }
  get globalDnd(): boolean { return this._globalDnd; }

  /** System OR global OR this service's DND — what the view is told to suppress on. */
  effectiveDnd(id: string): boolean {
    return this._systemDnd || this._globalDnd || (this.serviceDnd.get(id) ?? false);
  }

  shouldNotify(id: string): boolean {
    return shouldNotify({
      systemDnd: this._systemDnd,
      globalDnd: this._globalDnd,
      serviceDnd: this.serviceDnd.get(id) ?? false,
      focused: this.focused.get(id) ?? false,
      visible: this.visible.get(id) ?? false,
    });
  }
}
