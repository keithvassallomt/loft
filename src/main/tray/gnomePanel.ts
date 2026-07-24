import { TrayModel } from './model';
import type { Tray, TrayDeps } from './index';
import type { ShellHelperClient } from '../gnome/shellHelper';

export interface PanelSnapshot {
  /** The D-Bus segment, which is also the helper's own key for this row. */
  id: string;
  displayName: string;
  visible: boolean;
  badge: number;
  dnd: boolean;
}

/** Pure diff of previous vs current per-service snapshots (flash-avoidance, gnome.rs:186-199). */
export function diffPanelServices(
  prev: Map<string, PanelSnapshot>,
  cur: Map<string, PanelSnapshot>,
): { updates: PanelSnapshot[]; removals: string[] } {
  const updates: PanelSnapshot[] = [];
  const removals: string[] = [];
  for (const id of prev.keys()) if (!cur.has(id)) removals.push(id);
  for (const [id, s] of cur) {
    const p = prev.get(id);
    if (!p || p.displayName !== s.displayName || p.visible !== s.visible || p.badge !== s.badge || p.dnd !== s.dnd)
      updates.push(s);
  }
  return { updates, removals };
}

export async function startGnomePanelTray(deps: TrayDeps, helper: ShellHelperClient): Promise<Tray> {
  const model = new TrayModel();
  model.setGlobalDnd(deps.globalDnd);
  for (const s of deps.configuredServices)
    model.addService({ id: s.id, displayName: s.displayName, segment: s.segment, badge: 0, dnd: s.dnd, visible: s.visible, running: s.running });

  // Snapshot of only-running services (they carry the Show/Hide/DND/Quit controls).
  let prev = new Map<string, PanelSnapshot>();
  const snapshot = (): Map<string, PanelSnapshot> => {
    const mm = model.menuModel();
    const m = new Map<string, PanelSnapshot>();
    for (const r of mm.running) {
      m.set(r.segment, { id: r.segment, displayName: r.label, visible: r.visible, badge: 0, dnd: r.dnd });
    }
    // menuModel doesn't carry raw badge; read it from the model's per-service view.
    for (const s of model.snapshotServices()) if (m.has(s.segment)) m.get(s.segment)!.badge = s.badge;
    return m;
  };

  // Snapshot of configured-but-not-running services — pushed on a separate channel so
  // the panel menu can offer a launch row for each (parity with the SNI menu's
  // available section). They carry no live state, so the diff only tracks presence +
  // display name; the fixed visible/badge/dnd let us reuse diffPanelServices.
  let prevAvail = new Map<string, PanelSnapshot>();
  const snapshotAvailable = (): Map<string, PanelSnapshot> => {
    const m = new Map<string, PanelSnapshot>();
    for (const a of model.menuModel().available) {
      m.set(a.segment, { id: a.segment, displayName: a.label, visible: false, badge: 0, dnd: false });
    }
    return m;
  };

  // Global DND lives outside the per-service snapshot, so it gets its own
  // diff + push (the extension has no other way to learn the state, and must
  // know it to render the switch and grey the panel icon).
  let prevGlobalDnd = model.menuModel().globalDnd;

  const pushAll = (): void => {
    prevGlobalDnd = model.menuModel().globalDnd;
    void helper.updateGlobalDnd(prevGlobalDnd);
    for (const s of prev.values())
      void helper.updateCombinedService(s.id, s.displayName, s.visible, s.badge, s.dnd, s.displayName);
    for (const s of prevAvail.values())
      void helper.updateAvailableService(s.id, s.displayName);
  };

  const refresh = (): void => {
    const globalDnd = model.menuModel().globalDnd;
    if (globalDnd !== prevGlobalDnd) {
      prevGlobalDnd = globalDnd;
      void helper.updateGlobalDnd(globalDnd);
    }
    const cur = snapshot();
    const { updates, removals } = diffPanelServices(prev, cur);
    for (const id of removals) void helper.removeCombinedService(id);
    for (const u of updates) void helper.updateCombinedService(u.id, u.displayName, u.visible, u.badge, u.dnd, u.displayName);
    prev = cur;

    // Available channel. A launch/quit flips a service between running and available,
    // so each transition surfaces here as a removal on one channel and an add on the
    // other — the extension keeps a service in exactly one section.
    const curAvail = snapshotAvailable();
    const avail = diffPanelServices(prevAvail, curAvail);
    for (const id of avail.removals) void helper.removeAvailableService(id);
    for (const u of avail.updates) void helper.updateAvailableService(u.id, u.displayName);
    prevAvail = curAvail;
  };

  // Register the combined icon once. The client is fire-and-forget (never
  // rejects), so login/restart races are handled by onHelperAppeared below
  // (re-register whenever chat.loft.ShellHelper (re)appears) rather than a
  // backoff — this replaces gnome.rs's [0,2,4,8,16]s retry, whose purpose was
  // to await a register() that could fail; ours can't.
  await helper.registerCombined('loft-symbolic');
  prev = snapshot();
  prevAvail = snapshotAvailable();
  pushAll();
  model.onChange = refresh;

  // Suspend/resume: extension disable()/enable() destroys the panel button;
  // a helper restart re-owns the name → re-register + re-push everything
  // (parity with monitor_shell_helper_restart, mod.rs:1307-1383).
  helper.onHelperAppeared(() => {
    void helper.registerCombined('loft-symbolic');
    prev = snapshot();
    prevAvail = snapshotAvailable();
    pushAll();
  });

  return {
    addService: (seed) => model.addService({ id: seed.id, displayName: seed.displayName, segment: seed.segment, badge: 0, dnd: seed.dnd, visible: false, running: false }),
    setBadge: (id, n) => model.setBadge(id, n),
    setRunning: (id, running) => model.setRunning(id, running),
    setVisible: (id, visible) => model.setVisible(id, visible),
    setDnd: (id, enabled) => model.setDnd(id, enabled),
    setGlobalDnd: (enabled) => model.setGlobalDnd(enabled),
    setDisplayName: (id, name) => model.setDisplayName(id, name),
    removeService: (id) => model.removeService(id),
  };
}
