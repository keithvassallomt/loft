import type { LoftConfig } from './config';
import type { ServiceKind } from './registry';
import { bubbleGlyph, bubbleHue, type Bubble } from './bubbles';
import { GRID_ID, services as gridServices, type GridNode } from './gridTree';

/** One entry in the Loft window's service rail. */
export interface RailItem {
  id: string;
  displayName: string;
  /** Already gated: 0 when sleeping or when the service disables badges. */
  badge: number;
  dnd: boolean;
  /** Installed but not loaded — no view, no badges, no notifications until clicked. */
  sleeping: boolean;
  /** Lives in its own window; clicking raises that window rather than selecting a tab. */
  detached: boolean;
  /** The selected tab. At most one, and never a detached service. */
  active: boolean;
}

/** One pinned conversation as the rail renders it. */
export interface BubbleItem {
  id: string;
  title: string;
  /** Instance id — what a click resolves against. */
  serviceId: string;
  /** Kind — selects the small service icon badged bottom-right. */
  kind: string;
  /** 1-2 characters drawn when there is no avatar — every Slack channel, and anyone with no
   *  profile picture. Computed here rather than in the renderer, which cannot import. */
  glyph: string;
  /** Stable hue for that lettered fallback, so two of them differ by colour as well. */
  hue: number;
  /** Unread mark. Already gated: false when the service sleeps or has badges disabled. */
  unread: boolean;
  /**
   * Service not loaded — rendered greyed, exactly as a sleeping service icon is.
   *
   * Without this a bubble with no dot would be ambiguous between "nothing unread" and "nobody
   * is looking", and those are very different things to someone deciding whether they have
   * been messaged.
   */
  sleeping: boolean;
}

export interface BubbleItemInput {
  bubbles: readonly Bubble[];
  installed: ReadonlySet<string>;
  kindOf(serviceId: string): string;
  /** No view -> no honest unread answer; the bubble renders greyed. */
  sleeping(serviceId: string): boolean;
  /** Fully gated by the caller — see buildRailState. Takes the title as well as the key
   *  because one service (Element) can only report titles; see ConversationAdapter.unreadKeys. */
  unread(serviceId: string, key: string, title: string): boolean;
}

/**
 * Bubbles for the rail, in pin order.
 *
 * A bubble whose service is no longer installed is omitted rather than drawn: clicking it
 * could only fail. Config cleanup happens on service removal; this filter is the safety net
 * for a hand-edited config, and for the window between the two.
 */
export function buildBubbleItems(i: BubbleItemInput): BubbleItem[] {
  return i.bubbles
    .filter((b) => i.installed.has(b.serviceId))
    .map((b) => ({
      id: b.id,
      title: b.title,
      serviceId: b.serviceId,
      kind: i.kindOf(b.serviceId),
      glyph: bubbleGlyph(b.title),
      hue: bubbleHue(b.key),
      unread: i.unread(b.serviceId, b.key, b.title),
      sleeping: i.sleeping(b.serviceId),
    }));
}

/** The rail renderer's full state: the service items, plus which of the two pinned
 *  entries — the Loft "home" button and the Grid button — is the current selection. */
export interface RailState {
  items: RailItem[];
  managerActive: boolean;
  /** The Grid entry is the selection. Mutually exclusive with managerActive and with
   *  any item's `active`. */
  gridActive: boolean;
  /** How many services are in the grid; the entry renders a count when non-zero. */
  gridCount: number;
  /** Pinned conversations, drawn below the services behind their own divider. */
  bubbles: BubbleItem[];
  /** Cache-buster for loft://icon/<id> URLs. The URL is stable across an icon change, so
   *  the rail would otherwise keep Chromium's cached image; the renderer appends `?e=<n>`,
   *  and main bumps this whenever an icon is re-deployed. */
  iconEpoch: number;
}

export interface RailModelInput {
  /** The registry, in its canonical order — the tiebreak for anything railOrder omits. */
  services: ServiceKind[];
  config: LoftConfig;
  loaded(id: string): boolean;
  detached(id: string): boolean;
  badge(id: string): number;
  activeId: string | undefined;
}

/**
 * Installed service ids in rail order. Extracted so main can compute the same order the
 * rail renders without duplicating the ranking rule — a drag writes railOrder, and it must
 * agree with what the user saw.
 */
export function orderedRailIds(services: readonly ServiceKind[], config: LoftConfig): string[] {
  const installed = services.filter((d) => config.services[d.id] !== undefined);
  const order = config.railOrder ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + installed.findIndex((d) => d.id === id) : at;
  };
  return [...installed].sort((a, b) => rank(a.id) - rank(b.id)).map((d) => d.id);
}

/**
 * The rail lists every INSTALLED service — including detached ones (spec 09 §3). It is
 * the service list, not the tab strip: that is what makes it the way back from a
 * detached window, and what keeps railOrder meaningful across attach/detach.
 */
export function buildRailModel(i: RailModelInput): RailItem[] {
  const byId = new Map(i.services.map((d) => [d.id, d]));

  return orderedRailIds(i.services, i.config)
    .map((id) => byId.get(id)!)
    .map((d) => {
      const cfg = i.config.services[d.id] ?? {};
      const sleeping = !i.loaded(d.id);
      const detached = i.detached(d.id);
      // badgesEnabled is absent-means-true. A sleeping service has no view and so
      // cannot have a count; showing a stale one would claim unread messages that
      // nothing is watching for.
      const badgesOn = cfg.badgesEnabled !== false;
      return {
        id: d.id,
        displayName: d.displayName,
        badge: sleeping || !badgesOn ? 0 : i.badge(d.id),
        dnd: cfg.dnd === true,
        sleeping,
        detached,
        active: !detached && i.activeId === d.id,
      };
    });
}

export interface RailStateInput extends RailModelInput {
  grid: GridNode | null;
  /** Current icon cache-buster (see RailState.iconEpoch). */
  iconEpoch: number;
  /** Pinned conversations, in pin order. */
  bubbles: readonly Bubble[];
  /** Instance id -> kind, for the corner badge. */
  kindOf(serviceId: string): string;
  /** Conversation keys currently unread for a service, as reported by its preload. */
  unreadKeys(serviceId: string): ReadonlySet<string>;
}

/**
 * The whole rail state in one call, so the grid's activeness is derived in exactly one
 * place. GRID_ID is a reserved activeId — it is never a service id, so buildRailModel
 * naturally marks no item active when the grid is selected.
 */
export function buildRailState(i: RailStateInput): RailState {
  return {
    items: buildRailModel(i),
    managerActive: i.activeId === undefined,
    gridActive: i.activeId === GRID_ID,
    gridCount: gridServices(i.grid).length,
    bubbles: buildBubbleItems({
      bubbles: i.bubbles,
      installed: new Set(i.services.filter((d) => i.config.services[d.id] !== undefined).map((d) => d.id)),
      kindOf: i.kindOf,
      sleeping: (sid) => !i.loaded(sid),
      // The same two gates buildRailModel applies to a service's own badge, for the same
      // reasons: a sleeping service has no view and so cannot have an honest answer, and a
      // service with badges disabled should not get one by another route. DND is deliberately
      // NOT a gate — it does not suppress service badges, and the rail shows it separately
      // with its own mark.
      // Key OR title: five services report conversation keys, and Element reports room
      // TITLES because its markup contains no room id anywhere (measured). The two cannot
      // collide — the sets are per-service, and no service reports both forms.
      unread: (sid, key, title) => i.loaded(sid)
        && i.config.services[sid]?.badgesEnabled !== false
        && (i.unreadKeys(sid).has(key) || i.unreadKeys(sid).has(title)),
    }),
    iconEpoch: i.iconEpoch,
  };
}

/**
 * Which service the Loft window should select when `closingId` stops being a tab
 * (unloaded, detached, or removed). Next one along, else the previous; undefined when
 * no selectable tab remains — the caller then shows the manager, which is the correct
 * empty state rather than a special case.
 *
 * "Selectable" excludes both detached AND sleeping services: a detached one lives in its
 * own window, and a sleeping one has no view, so handing either back would make select()
 * refuse it and leave a dead active id over a blank content rect. `closingId` itself is
 * loaded at call time (the ordering contract on LoftWindow.detach guarantees it), so it
 * survives the filter and its position is found.
 */
export function nextActiveId(items: RailItem[], closingId: string): string | undefined {
  const attached = items.filter((it) => !it.detached && !it.sleeping);
  const at = attached.findIndex((it) => it.id === closingId);
  if (at === -1) return undefined;
  const rest = attached.filter((it) => it.id !== closingId);
  if (rest.length === 0) return undefined;
  return (rest[at] ?? rest[at - 1] ?? rest[rest.length - 1]).id;
}
