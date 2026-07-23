import * as dbus from 'dbus-next';
import { KINDS } from '../registry';
import { dbusName } from './names';

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

export async function startLoftDbusService(deps: LoftServiceDeps): Promise<void> {
  const bus = dbus.sessionBus();
  await bus.requestName(BUS, 0);
  bus.export('/chat/loft/Loft', new LoftRootObject(deps));
  for (const svc of KINDS) {
    bus.export(`/chat/loft/${dbusName(svc.displayName)}`, new LoftServiceObject(svc.id, deps));
  }
}
