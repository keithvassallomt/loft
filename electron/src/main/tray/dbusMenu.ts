import * as dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;
const Variant = dbus.Variant;
type Variant = dbus.Variant;

/** The state the menu is rendered from (produced by `TrayModel`). */
export interface MenuModel {
  services: Array<{ id: string; label: string; unread: boolean; dnd: boolean; visible: boolean }>;
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

/**
 * The `com.canonical.dbusmenu` object backing the SNI tray's left-click menu.
 * Rebuilt from a `MenuModel` on every change (`setModel`), which bumps the
 * revision and emits `LayoutUpdated`. Leaf clicks arrive via `Event(id,
 * "clicked", …)` and dispatch to `onEvent(actionId)`.
 *
 * Layout (per plan §3a Task 4):
 *   Show / Hide Loft            (hub)
 *   ──────────
 *   <Service> [•]               submenu (bullet when unread)
 *     Do Not Disturb  ☑         (svc:<id>:dnd)
 *     Show/Hide Window          (svc:<id>:toggle)
 *   …one submenu per service…
 *   ──────────
 *   Settings…                   (settings)
 *   Quit                        (quit)
 */
export class DbusMenu extends Interface {
  private revision = 1;
  private root: MenuNode;
  private actions = new Map<number, string>();

  /** Invoked with a stable action id (`hub` | `settings` | `quit` | `svc:<id>:toggle` | `svc:<id>:dnd`). */
  onEvent: (actionId: string) => void = () => {};

  constructor() {
    super('com.canonical.dbusmenu');
    const built = buildTree({ services: [] });
    this.root = built.root;
    this.actions = built.actions;
  }

  /** Rebuild the menu from a new model, bump the revision, and notify hosts. */
  setModel(model: MenuModel): void {
    const built = buildTree(model);
    this.root = built.root;
    this.actions = built.actions;
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

function buildTree(model: MenuModel): { root: MenuNode; actions: Map<number, string> } {
  const actions = new Map<number, string>();
  let nextId = 1;

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

  const children: MenuNode[] = [];
  children.push(item('Show / Hide Loft', 'hub'));
  children.push(separator());

  for (const s of model.services) {
    const title = s.unread ? `${s.label} •` : s.label; // • bullet when unread
    const sub = item(title, undefined, { 'children-display': V('s', 'submenu') });
    sub.children.push(
      item('Do Not Disturb', `svc:${s.id}:dnd`, {
        'toggle-type': V('s', 'checkmark'),
        'toggle-state': V('i', s.dnd ? 1 : 0),
      }),
      item(s.visible ? 'Hide Window' : 'Show Window', `svc:${s.id}:toggle`),
    );
    children.push(sub);
  }

  children.push(separator());
  children.push(item('Settings…', 'settings'));
  children.push(item('Quit', 'quit'));

  const root: MenuNode = { id: 0, props: { 'children-display': new Variant('s', 'submenu') }, children };
  return { root, actions };
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
