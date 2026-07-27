import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';
import { startNotifyBridge } from './notify/bridge';
import { startContextMenuBridge } from './contextMenu';
import { startConversationWatch } from './conversation/watch';
import { CONVERSATION_ADAPTERS } from './conversation/adapters';
import { executePlan } from './conversation/open';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startNotifyBridge(serviceId, { ipc: ipcRenderer, win: window, doc: document });
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);

  // `serviceId` here is the KIND — --loft-service carries the kind, never the instance id —
  // which is exactly what selects the adapter, the same way it selects the badge parser.
  startConversationWatch(serviceId, {
    doc: document,
    win: window,
    send: (conversation) => ipcRenderer.send('service:conversation', conversation),
    sendUnread: (keys) => ipcRenderer.send('service:unread', keys),
  });

  // A bubble was clicked. Build the plan for this kind and carry it out; the outcome is
  // advisory (main leaves the user on the service either way) but is reported so a future
  // stale-bubble indicator has a signal to build on.
  ipcRenderer.on('bubble:open', (_e, m?: { key?: unknown }) => {
    const key = m?.key;
    if (typeof key !== 'string') return;
    const adapter = CONVERSATION_ADAPTERS[serviceId];
    if (!adapter) { ipcRenderer.send('bubble:opened', { key, outcome: 'not-found' }); return; }
    void executePlan(adapter.plan(key, document, window), {
      doc: document,
      win: window,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      scroller: adapter.scroller?.(document) ?? null,
    }).then((outcome) => ipcRenderer.send('bubble:opened', { key, outcome }));
  });
  // Developer context menu — inert unless Settings → Developer mode is on (main pushes the
  // flag over service:debug). Not keyed on serviceId: the KIND is irrelevant to it, but it
  // still lives inside this `if` because a view with no service id is not a service view.
  startContextMenuBridge({ ipc: ipcRenderer, doc: document });
}
