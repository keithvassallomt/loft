import type { HubState } from '../../shared/hubTypes';

/** What the manager's right pane is showing. `{ service }` is a per-service settings pane. */
export type ManagerSelection = 'add' | 'settings' | 'about' | { service: string };

export interface ManagerNav {
  /** Installed services, in the order HubState lists them — the Configure list. */
  configure: { id: string; displayName: string }[];
}

export function managerNav(state: HubState): ManagerNav {
  return {
    configure: state.services
      .filter((s) => s.installed)
      .map((s) => ({ id: s.id, displayName: s.displayName })),
  };
}

/**
 * Normalise a selection against current state. A `{ service }` whose service is no longer
 * installed (removed here or elsewhere) folds back to 'add', so the detail pane never
 * renders a service that isn't there. Every other selection passes through.
 */
export function resolveSelection(sel: ManagerSelection, state: HubState): ManagerSelection {
  if (typeof sel === 'object' && sel !== null) {
    const ok = state.services.some((s) => s.id === sel.service && s.installed);
    return ok ? sel : 'add';
  }
  return sel;
}
