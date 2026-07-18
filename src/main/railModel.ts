import type { LoftConfig } from './config';
import type { ServiceDef } from './registry';

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

/** The rail renderer's full state: the service items plus whether the manager tab is the
 *  active selection, so the rail's Loft "home" button can render as current. */
export interface RailState {
  items: RailItem[];
  managerActive: boolean;
}

export interface RailModelInput {
  /** The registry, in its canonical order — the tiebreak for anything railOrder omits. */
  services: ServiceDef[];
  config: LoftConfig;
  loaded(id: string): boolean;
  detached(id: string): boolean;
  badge(id: string): number;
  activeId: string | undefined;
}

/**
 * The rail lists every INSTALLED service — including detached ones (spec 09 §3). It is
 * the service list, not the tab strip: that is what makes it the way back from a
 * detached window, and what keeps railOrder meaningful across attach/detach.
 */
export function buildRailModel(i: RailModelInput): RailItem[] {
  const installed = i.services.filter((d) => i.config.services[d.id] !== undefined);
  const order = i.config.railOrder ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + installed.findIndex((d) => d.id === id) : at;
  };

  return [...installed]
    .sort((a, b) => rank(a.id) - rank(b.id))
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
