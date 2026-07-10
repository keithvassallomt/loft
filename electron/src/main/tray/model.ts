import type { MenuModel } from './dbusMenu';
import { type OverlayKind, overlayFor } from './icon';

/** Per-service state the tray tracks. */
export interface ServiceTrayState {
  id: string;
  displayName: string;
  badge: number;
  dnd: boolean;
  visible: boolean;
  /** A window exists for this service (hidden-to-tray still counts as running). */
  running: boolean;
}

/**
 * Holds per-service tray state + a global DND flag, and derives the two rendered
 * artefacts: the icon overlay (`iconOverlay`) and the menu layout (`menuModel`,
 * split into running vs configured-not-running). Mutations fire `onChange` only
 * when something actually changed, so the tray doesn't rebuild on redundant updates.
 */
export class TrayModel {
  private services: ServiceTrayState[] = [];
  private globalDnd = false;

  /** Fired after any mutation that changed state. */
  onChange: (() => void) | null = null;

  addService(state: ServiceTrayState): void {
    if (this.find(state.id)) return;
    this.services.push({ ...state });
    this.changed();
  }

  hasService(id: string): boolean {
    return this.find(id) !== undefined;
  }

  setBadge(id: string, n: number): void {
    const s = this.find(id);
    if (s && s.badge !== n) { s.badge = n; this.changed(); }
  }

  setDnd(id: string, enabled: boolean): void {
    const s = this.find(id);
    if (s && s.dnd !== enabled) { s.dnd = enabled; this.changed(); }
  }

  setVisible(id: string, visible: boolean): void {
    const s = this.find(id);
    if (s && s.visible !== visible) { s.visible = visible; this.changed(); }
  }

  setRunning(id: string, running: boolean): void {
    const s = this.find(id);
    if (s && s.running !== running) { s.running = running; this.changed(); }
  }

  setGlobalDnd(enabled: boolean): void {
    if (this.globalDnd !== enabled) { this.globalDnd = enabled; this.changed(); }
  }

  /**
   * The overlay to render: a DND dash when everything is muted (global DND, or
   * every running service is DND), else a red dot when any running, non-DND
   * service has unread.
   */
  iconOverlay(): OverlayKind {
    const running = this.services.filter((s) => s.running);
    const allMuted = this.globalDnd || (running.length > 0 && running.every((s) => s.dnd));
    const totalUnread = this.globalDnd
      ? 0
      : running.filter((s) => !s.dnd).reduce((n, s) => n + Math.max(0, s.badge), 0);
    return overlayFor(totalUnread, allMuted);
  }

  /** A fresh snapshot of the menu state: global DND + running vs available sections. */
  menuModel(): MenuModel {
    const running = this.services.filter((s) => s.running);
    const available = this.services.filter((s) => !s.running);
    return {
      globalDnd: this.globalDnd,
      running: running.map((s) => ({
        id: s.id,
        label: s.displayName,
        unread: !this.globalDnd && !s.dnd && s.badge > 0,
        dnd: s.dnd,
        visible: s.visible,
      })),
      available: available.map((s) => ({ id: s.id, label: s.displayName })),
    };
  }

  private find(id: string): ServiceTrayState | undefined {
    return this.services.find((s) => s.id === id);
  }

  private changed(): void {
    this.onChange?.();
  }
}
