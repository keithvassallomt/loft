import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';
import { startNotifyBridge } from './notify/bridge';
import { startContextMenuBridge } from './contextMenu';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startNotifyBridge(serviceId, { ipc: ipcRenderer, win: window, doc: document });
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);
  // Developer context menu — inert unless Settings → Developer mode is on (main pushes the
  // flag over service:debug). Not keyed on serviceId: the KIND is irrelevant to it, but it
  // still lives inside this `if` because a view with no service id is not a service view.
  startContextMenuBridge({ ipc: ipcRenderer, doc: document });
}
