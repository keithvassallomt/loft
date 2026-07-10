import * as dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;

/** One SNI icon frame: [width, height, ARGB32 bytes (network byte order)]. */
export type IconPixmap = [number, number, Buffer];

/**
 * The `org.kde.StatusNotifierItem` D-Bus object for the single combined "Loft"
 * tray icon (port of `src/combined_tray/tray.rs`). Category/Id/Title/Status are
 * constant; the icon pixmap + tooltip are pushed at runtime from `TrayModel`.
 *
 * Left-click is a no-op (`Activate`) — SNI hosts open the `Menu` (dbusmenu at
 * `/MenuBar`) themselves, matching the Rust `MENU_ON_ACTIVATE` behaviour.
 *
 * Properties are exhaustive (not just the ones we vary) so a host's
 * `Properties.GetAll` never trips over an undeclared/undefined getter — every
 * getter returns a defined, correctly-typed value.
 */
export class SniItem extends Interface {
  private iconPixmap: IconPixmap[] = [];
  private toolTipText = 'Loft';

  /** Invoked on left-click `Activate`; hosts usually open the menu, so this is a no-op by default. */
  onActivate: () => void = () => {};

  constructor() {
    super('org.kde.StatusNotifierItem');
  }

  // ---- Properties (all read-only) ----
  get Category(): string {
    return 'Communications';
  }
  get Id(): string {
    return 'chat.loft.Loft';
  }
  get Title(): string {
    return 'Loft';
  }
  get Status(): string {
    return 'Active';
  }
  get WindowId(): number {
    return 0;
  }
  get IconThemePath(): string {
    return '';
  }
  /** Themed-icon fallback used by hosts that ignore the pixmap. */
  get IconName(): string {
    return 'loft';
  }
  get IconPixmap(): IconPixmap[] {
    return this.iconPixmap;
  }
  get OverlayIconName(): string {
    return '';
  }
  get OverlayIconPixmap(): IconPixmap[] {
    return [];
  }
  get AttentionIconName(): string {
    return '';
  }
  get AttentionIconPixmap(): IconPixmap[] {
    return [];
  }
  get AttentionMovieName(): string {
    return '';
  }
  /** (iconName, iconPixmaps, title, description). */
  get ToolTip(): [string, IconPixmap[], string, string] {
    return ['', [], this.toolTipText, ''];
  }
  get ItemIsMenu(): boolean {
    return true;
  }
  get Menu(): string {
    return '/MenuBar';
  }

  // ---- Methods ----
  Activate(_x: number, _y: number): void {
    this.onActivate();
  }
  SecondaryActivate(_x: number, _y: number): void {
    /* no-op */
  }
  ContextMenu(_x: number, _y: number): void {
    /* no-op — host opens Menu */
  }
  Scroll(_delta: number, _orientation: string): void {
    /* no-op */
  }

  // ---- Signals (calling the method emits it) ----
  NewIcon(): void {
    /* emitted by setIconPixmap */
  }
  NewStatus(status: string): string {
    return status;
  }
  NewToolTip(): void {
    /* emitted by setToolTip */
  }
  NewTitle(): void {
    /* reserved */
  }

  /** Replace the icon pixmap and notify hosts. */
  setIconPixmap(pixmap: IconPixmap[]): void {
    this.iconPixmap = pixmap;
    this.NewIcon();
  }

  /** Replace the tooltip text and notify hosts. */
  setToolTip(text: string): void {
    this.toolTipText = text;
    this.NewToolTip();
  }
}

SniItem.configureMembers({
  properties: {
    Category: { signature: 's', access: ACCESS_READ },
    Id: { signature: 's', access: ACCESS_READ },
    Title: { signature: 's', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    WindowId: { signature: 'u', access: ACCESS_READ },
    IconThemePath: { signature: 's', access: ACCESS_READ },
    IconName: { signature: 's', access: ACCESS_READ },
    IconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    OverlayIconName: { signature: 's', access: ACCESS_READ },
    OverlayIconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    AttentionIconName: { signature: 's', access: ACCESS_READ },
    AttentionIconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    AttentionMovieName: { signature: 's', access: ACCESS_READ },
    ToolTip: { signature: '(sa(iiay)ss)', access: ACCESS_READ },
    ItemIsMenu: { signature: 'b', access: ACCESS_READ },
    Menu: { signature: 'o', access: ACCESS_READ },
  },
  methods: {
    Activate: { inSignature: 'ii', outSignature: '' },
    SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    ContextMenu: { inSignature: 'ii', outSignature: '' },
    Scroll: { inSignature: 'is', outSignature: '' },
  },
  signals: {
    NewIcon: { signature: '' },
    NewStatus: { signature: 's' },
    NewToolTip: { signature: '' },
    NewTitle: { signature: '' },
  },
});
