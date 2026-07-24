import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;
const Variant = dbus.Variant;
type Variant = dbus.Variant;

/** The state the menu is rendered from (produced by `TrayModel`). */
export interface MenuModel {
  globalDnd: boolean;
  /** Services with a live window (hidden-to-tray still counts). `segment` rides along
   *  unused here (the SNI menu's action ids are already `svc:<id>:…`) so the two tray
   *  backends can share one model — the GNOME panel is the one that dereferences it. */
  running: Array<{ id: string; label: string; segment: string; unread: boolean; dnd: boolean; visible: boolean }>;
  /** Configured services with no live window (click to launch). */
  available: Array<{ id: string; label: string; segment: string }>;
}

/** dbusmenu property map: `a{sv}`. */
type Props = Record<string, Variant>;

interface MenuNode {
  id: number;
  props: Props;
  children: MenuNode[];
}

/** Marshaller shape for a `(ia{sv}av)` layout node. */
type LayoutNode = [number, Props, Variant[]];

const LAYOUT_SIGNATURE = '(ia{sv}av)';

// Service icon bytes (full-colour PNG) for dbusmenu `icon-data`. Cached; a
// missing file just omits the icon rather than breaking the menu.
const iconCache = new Map<string, number[] | null>();
function serviceIconData(id: string): number[] | null {
  const cached = iconCache.get(id);
  if (cached !== undefined) return cached;
  let bytes: number[] | null = null;
  try {
    // dist/main/tray → dist/assets/icons/<id>.png (copied by copy-assets).
    bytes = Array.from(readFileSync(join(__dirname, '..', '..', 'assets', 'icons', `${id}.png`)));
  } catch {
    bytes = null;
  }
  iconCache.set(id, bytes);
  return bytes;
}

/**
 * The `com.canonical.dbusmenu` object backing the SNI tray's left-click menu.
 * Rebuilt from a `MenuModel` on every change (`setModel`), bumping the revision
 * and emitting `LayoutUpdated`. Leaf clicks arrive via `Event(id, "clicked", …)`
 * and dispatch to `onEvent(actionId)`.
 *
 * Layout:
 *   Show Window                       (show-window)
 *   ☑ Do Not Disturb                  (global:dnd)
 *   ──────────
 *   <Service> [•] ▸                   (submenu, one per running service)
 *       Show / Hide                   (svc:<id>:toggle)
 *       Do Not Disturb ☑              (svc:<id>:dnd)
 *       Quit                          (svc:<id>:quit → stop the service)
 *   ──────────                        (only if any available)
 *   <Service>                         (svc:<id>:launch)
 *   ──────────
 *   Settings…                         (settings)
 *   Quit Loft                         (quit)
 */
export class DbusMenu extends Interface {
  private revision = 1;
  private root: MenuNode;
  private actions = new Map<number, string>();
  // Monotonic, never reset across rebuilds. dbusmenu ids MUST NOT be reused for a
  // different item: KDE's plasmashell importer caches menu widgets by id and merges
  // new props onto the stale cached item when an id reappears, corrupting the menu
  // (e.g. a service row rendered with a leftover checkbox after a quit/launch shifts
  // the running/available split). GNOME's libdbusmenu re-fetches instead, so it was
  // unaffected. Handing out fresh ids every rebuild keeps the id→item mapping stable.
  private nextId = 1;

  /** Invoked with a stable action id (`global:dnd` | `settings` | `quit` | `svc:<id>:{toggle,dnd,quit,launch}`). */
  onEvent: (actionId: string) => void = () => {};

  constructor() {
    super('com.canonical.dbusmenu');
    const built = buildTree({ globalDnd: false, running: [], available: [] }, this.nextId);
    this.root = built.root;
    this.actions = built.actions;
    this.nextId = built.nextId;
  }

  /** Rebuild the menu from a new model, bump the revision, and notify hosts. */
  setModel(model: MenuModel): void {
    const built = buildTree(model, this.nextId);
    this.root = built.root;
    this.actions = built.actions;
    this.nextId = built.nextId;
    this.revision += 1;
    this.LayoutUpdated(this.revision, 0);
  }

  // ---- Properties ----
  get Version(): number {
    return 3;
  }
  get Status(): string {
    return 'normal';
  }
  get TextDirection(): string {
    return 'ltr';
  }
  get IconThemePath(): string[] {
    return [];
  }

  // ---- Methods ----
  GetLayout(parentId: number, recursionDepth: number, propertyNames: string[]): [number, LayoutNode] {
    const start = findNode(this.root, parentId) ?? this.root;
    return [this.revision, serializeNode(start, recursionDepth, propertyNames)];
  }

  GetGroupProperties(ids: number[], propertyNames: string[]): Array<[number, Props]> {
    const all = flatten(this.root);
    const out: Array<[number, Props]> = [];
    for (const id of ids) {
      const node = all.find((n) => n.id === id);
      if (node) out.push([id, filterProps(node.props, propertyNames)]);
    }
    return out;
  }

  GetProperty(id: number, name: string): Variant {
    const node = flatten(this.root).find((n) => n.id === id);
    return node?.props[name] ?? new Variant('s', '');
  }

  Event(id: number, eventId: string, _data: Variant, _timestamp: number): void {
    if (eventId !== 'clicked') return;
    const action = this.actions.get(id);
    if (action) this.onEvent(action);
  }

  EventGroup(events: Array<[number, string, Variant, number]>): number[] {
    for (const [id, eventId] of events) {
      if (eventId !== 'clicked') continue;
      const action = this.actions.get(id);
      if (action) this.onEvent(action);
    }
    return []; // no id errors
  }

  AboutToShow(_id: number): boolean {
    return false; // updates are pushed proactively via LayoutUpdated
  }

  AboutToShowGroup(_ids: number[]): [number[], number[]] {
    return [[], []];
  }

  // ---- Signals ----
  LayoutUpdated(revision: number, parent: number): [number, number] {
    return [revision, parent];
  }
  ItemsPropertiesUpdated(updated: Array<[number, Props]>, removed: Array<[number, string[]]>): [Array<[number, Props]>, Array<[number, string[]]>] {
    return [updated, removed];
  }
  ItemActivationRequested(id: number, timestamp: number): [number, number] {
    return [id, timestamp];
  }
}

DbusMenu.configureMembers({
  properties: {
    Version: { signature: 'u', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    TextDirection: { signature: 's', access: ACCESS_READ },
    IconThemePath: { signature: 'as', access: ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu', outSignature: '' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: {
    LayoutUpdated: { signature: 'ui' },
    ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' },
    ItemActivationRequested: { signature: 'iu' },
  },
});

// ---- Tree construction ----

function buildTree(
  model: MenuModel,
  startId: number,
): { root: MenuNode; actions: Map<number, string>; nextId: number } {
  const actions = new Map<number, string>();
  let nextId = startId;

  const V = (sig: string, val: unknown): Variant => new Variant(sig, val);

  const item = (label: string, action: string | undefined, extra: Props = {}): MenuNode => {
    const id = nextId++;
    if (action) actions.set(id, action);
    return {
      id,
      props: { label: V('s', label), enabled: V('b', true), visible: V('b', true), ...extra },
      children: [],
    };
  };
  const separator = (): MenuNode => ({
    id: nextId++,
    props: { type: V('s', 'separator'), visible: V('b', true) },
    children: [],
  });
  const svcIcon = (id: string): Props => {
    const bytes = serviceIconData(id);
    return bytes ? { 'icon-data': V('ay', bytes) } : {};
  };
  const toggle = (state: boolean): Props => ({
    'toggle-type': V('s', 'checkmark'),
    'toggle-state': V('i', state ? 1 : 0),
  });

  const children: MenuNode[] = [];

  // Show the Loft window as it was left. Deliberately not 'settings' — that routes to
  // onShowHub, which switches to the manager first (see tray/index.ts).
  children.push(item('Show Window', 'show-window', {
    'icon-name': V('s', 'window-symbolic'),
  }));

  // Global DND toggle.
  children.push(
    item('Do Not Disturb', 'global:dnd', {
      ...toggle(model.globalDnd),
      'icon-name': V('s', 'notifications-disabled-symbolic'),
    }),
  );
  children.push(separator());

  // Running services: the service name is a SUBMENU whose children are that
  // service's actions (Show/Hide, Do Not Disturb, Quit). A submenu parent has no
  // click action of its own (clicking it opens the submenu), so the former
  // click-the-row-to-show/hide moved into the submenu as an explicit Show/Hide.
  for (const s of model.running) {
    const svc = item(s.unread ? `${s.label} •` : s.label, undefined, {
      ...svcIcon(s.id),
      'children-display': V('s', 'submenu'),
    });
    svc.children.push(
      item(s.visible ? 'Hide' : 'Show', `svc:${s.id}:toggle`),
      item('Do Not Disturb', `svc:${s.id}:dnd`, {
        ...toggle(s.dnd),
        'icon-name': V('s', 'notifications-disabled-symbolic'),
      }),
      item('Quit', `svc:${s.id}:quit`, { 'icon-name': V('s', 'window-close-symbolic') }),
    );
    children.push(svc);
  }

  // Configured-but-not-running services: click launches them.
  if (model.available.length > 0) {
    children.push(separator());
    for (const s of model.available) {
      children.push(item(s.label, `svc:${s.id}:launch`, svcIcon(s.id)));
    }
  }

  children.push(separator());
  children.push(item('Settings…', 'settings', { 'icon-name': V('s', 'preferences-system-symbolic') }));
  children.push(item('Quit Loft', 'quit', { 'icon-name': V('s', 'application-exit-symbolic') }));

  const root: MenuNode = { id: 0, props: { 'children-display': new Variant('s', 'submenu') }, children };
  return { root, actions, nextId };
}

function serializeNode(node: MenuNode, depth: number, propertyNames: string[]): LayoutNode {
  const props = filterProps(node.props, propertyNames);
  let childVariants: Variant[] = [];
  if (depth !== 0) {
    const childDepth = depth < 0 ? -1 : depth - 1;
    childVariants = node.children.map(
      (c) => new Variant(LAYOUT_SIGNATURE, serializeNode(c, childDepth, propertyNames)),
    );
  }
  return [node.id, props, childVariants];
}

function filterProps(props: Props, propertyNames: string[]): Props {
  if (!propertyNames || propertyNames.length === 0) return props;
  const out: Props = {};
  for (const name of propertyNames) {
    if (name in props) out[name] = props[name];
  }
  return out;
}

function findNode(node: MenuNode, id: number): MenuNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function flatten(node: MenuNode, acc: MenuNode[] = []): MenuNode[] {
  acc.push(node);
  for (const child of node.children) flatten(child, acc);
  return acc;
}
