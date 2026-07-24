import * as dbus from 'dbus-next';
import type { ServiceInstance } from '../instances';

const { Interface, ACCESS_READ } = dbus.interface;
const BUS = 'chat.loft.Loft';
const IFACE = 'chat.loft.Service';

export interface LoftServiceDeps {
  show(id: string): void;
  hide(id: string): void;
  toggle(id: string): void;
  quitService(id: string): void;
  getStatus(id: string): [boolean, number, boolean];
  setDnd(id: string, enabled: boolean): void;
  setBadgesEnabled(id: string, enabled: boolean): void;
  quitApp(): void;
  /** Open/focus the hub window (the GNOME-panel "Loft Settings…" item calls this). */
  showHub(): void;
  /** Show the Loft window without switching to the manager. */
  showWindow(): void;
  /** Toggle global DND (the GNOME-panel "Do Not Disturb" switch calls this). */
  setGlobalDnd(enabled: boolean): void;
  /** Installed accounts to export at startup. */
  instances(): ServiceInstance[];
}

/** Per-service object exported at /chat/loft/<DbusName>, interface chat.loft.Service. */
class LoftServiceObject extends Interface {
  constructor(private id: string, private deps: LoftServiceDeps) { super(IFACE); }
  Show(): void { this.deps.show(this.id); }
  Hide(): void { this.deps.hide(this.id); }
  Toggle(): void { this.deps.toggle(this.id); }
  Quit(): void { this.deps.quitService(this.id); }
  GetStatus(): [boolean, number, boolean] { return this.deps.getStatus(this.id); }
  SetDnd(enabled: boolean): void { this.deps.setDnd(this.id, enabled); }
  SetBadgesEnabled(enabled: boolean): void { this.deps.setBadgesEnabled(this.id, enabled); }
}
LoftServiceObject.configureMembers({
  properties: {},
  methods: {
    Show: { inSignature: '', outSignature: '' },
    Hide: { inSignature: '', outSignature: '' },
    Toggle: { inSignature: '', outSignature: '' },
    Quit: { inSignature: '', outSignature: '' },
    GetStatus: { inSignature: '', outSignature: 'bub' },
    SetDnd: { inSignature: 'b', outSignature: '' },
    SetBadgesEnabled: { inSignature: 'b', outSignature: '' },
  },
  signals: {},
});

/** Root app object at /chat/loft/Loft, interface chat.loft.Loft. */
class LoftRootObject extends Interface {
  constructor(private deps: LoftServiceDeps) { super(BUS); }
  Quit(): void { this.deps.quitApp(); }
  ShowHub(): void { this.deps.showHub(); }
  ShowWindow(): void { this.deps.showWindow(); }
  SetGlobalDnd(enabled: boolean): void { this.deps.setGlobalDnd(enabled); }
}
LoftRootObject.configureMembers({
  properties: {},
  methods: {
    Quit: { inSignature: '', outSignature: '' },
    ShowHub: { inSignature: '', outSignature: '' },
    ShowWindow: { inSignature: '', outSignature: '' },
    SetGlobalDnd: { inSignature: 'b', outSignature: '' },
  },
  signals: {},
});

/** Where a service object lives. One function so the export, the unexport and any
 *  future consumer cannot drift. */
export function objectPathFor(segment: string): string {
  return `/chat/loft/${segment}`;
}

export interface LoftDbus {
  exportInstance(inst: ServiceInstance): void;
  unexportInstance(inst: ServiceInstance): void;
}

/** Where createExportRegistry sends the objects it decides to (un)export. Real callers
 *  hand it the live bus; tests hand it a recorder, since dbus-next can't be touched
 *  without a session bus to talk to. */
export interface ExportSink<T> {
  export(path: string, obj: T): void;
  unexport(path: string, obj: T): void;
}

/** Pure export/unexport bookkeeping, split out from startLoftDbusService so the
 *  duplicate-path guard (and the ownership check that keeps unexport from undoing it)
 *  can be driven by a fake sink under Vitest — no real bus required.
 *
 *  Keyed by path and, per entry, by owning instance id: segments are unique by
 *  construction, but a hand-edited config can make two ids derive the same one. When
 *  that happens the second export is refused (below), and without the id check here the
 *  second instance's later *unexport* would still find the first instance's live object
 *  at that path and tear it down out from under it — the duplicate guard would protect
 *  export but not removal. */
export function createExportRegistry<T>(sink: ExportSink<T>) {
  const exported = new Map<string, { id: string; obj: T }>();

  return {
    exportInstance(inst: ServiceInstance, makeObj: () => T): void {
      const path = objectPathFor(inst.dbusSegment);
      if (exported.has(path)) {
        console.warn(`Not exporting ${inst.id}: ${path} is already taken`);
        return;
      }
      const obj = makeObj();
      exported.set(path, { id: inst.id, obj });
      sink.export(path, obj);
    },
    unexportInstance(inst: ServiceInstance): void {
      const path = objectPathFor(inst.dbusSegment);
      const entry = exported.get(path);
      // Not this instance's path to give up — either nothing is exported there, or the
      // live object belongs to whichever instance won the duplicate-path race above.
      if (!entry || entry.id !== inst.id) return;
      exported.delete(path);
      sink.unexport(path, entry.obj);
    },
  };
}

export async function startLoftDbusService(deps: LoftServiceDeps): Promise<LoftDbus> {
  const bus = dbus.sessionBus();
  await bus.requestName(BUS, 0);
  bus.export('/chat/loft/Loft', new LoftRootObject(deps));

  const registry = createExportRegistry<LoftServiceObject>({
    export: (path, obj) => bus.export(path, obj),
    unexport: (path, obj) => bus.unexport(path, obj),
  });

  const api: LoftDbus = {
    exportInstance(inst) {
      registry.exportInstance(inst, () => new LoftServiceObject(inst.id, deps));
    },
    unexportInstance(inst) {
      registry.unexportInstance(inst);
    },
  };

  // Per INSTANCE, not per registry entry: an uninstalled service no longer has a D-Bus
  // object, and a second account gets its own.
  for (const inst of deps.instances()) api.exportInstance(inst);
  return api;
}
