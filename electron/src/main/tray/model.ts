import type { MenuModel } from './dbusMenu';
import { type OverlayKind, overlayFor } from './icon';

/** Per-service state the tray tracks. */
export interface ServiceTrayState {
  id: string;
  displayName: string;
  badge: number;
  dnd: boolean;
  visible: boolean;
}

/**
 * Holds per-service tray state and derives the two rendered artefacts: the
 * icon overlay (`iconOverlay`) and the menu layout (`menuModel`). Mutations
 * fire `onChange` — but only when they actually change something, so the tray
 * doesn't rebuild its icon/menu on redundant updates (matches tray.rs's
 * change-gated sync loop).
 */
export class TrayModel {
  private services: ServiceTrayState[] = [];

  /** Fired after any mutation that changed state. */
  onChange: (() => void) | null = null;

  addService(state: ServiceTrayState): void {
    this.services.push({ ...state });
    this.changed();
  }

  setBadge(id: string, n: number): void {
    const s = this.find(id);
    if (s && s.badge !== n) {
      s.badge = n;
      this.changed();
    }
  }

  setDnd(id: string, enabled: boolean): void {
    const s = this.find(id);
    if (s && s.dnd !== enabled) {
      s.dnd = enabled;
      this.changed();
    }
  }

  setVisible(id: string, visible: boolean): void {
    const s = this.find(id);
    if (s && s.visible !== visible) {
      s.visible = visible;
      this.changed();
    }
  }

  /** The overlay to render: DND dash if any service is DND, else unread dot if any unread. */
  iconOverlay(): OverlayKind {
    const anyDnd = this.services.some((s) => s.dnd);
    const totalUnread = this.services
      .filter((s) => !s.dnd)
      .reduce((n, s) => n + Math.max(0, s.badge), 0);
    return overlayFor(totalUnread, anyDnd);
  }

  /** A fresh snapshot of the menu state (per-service unread = badge>0 && !dnd). */
  menuModel(): MenuModel {
    return {
      services: this.services.map((s) => ({
        id: s.id,
        label: s.displayName,
        unread: s.badge > 0 && !s.dnd,
        dnd: s.dnd,
        visible: s.visible,
      })),
    };
  }

  private find(id: string): ServiceTrayState | undefined {
    return this.services.find((s) => s.id === id);
  }

  private changed(): void {
    this.onChange?.();
  }
}
