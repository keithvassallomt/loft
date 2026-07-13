import * as dbus from 'dbus-next';
import { SERVICES } from '../registry';
import { dbusName } from './names';

const { Interface } = dbus.interface;
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
}
LoftRootObject.configureMembers({
  properties: {},
  methods: { Quit: { inSignature: '', outSignature: '' } },
  signals: {},
});

export async function startLoftDbusService(deps: LoftServiceDeps): Promise<void> {
  const bus = dbus.sessionBus();
  await bus.requestName(BUS, 0);
  bus.export('/chat/loft/Loft', new LoftRootObject(deps));
  for (const svc of SERVICES) {
    bus.export(`/chat/loft/${dbusName(svc.displayName)}`, new LoftServiceObject(svc.id, deps));
  }
}
