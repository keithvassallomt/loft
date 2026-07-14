import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';
import { startNotifyBridge } from './notify/bridge';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startNotifyBridge(serviceId, { ipc: ipcRenderer, win: window, doc: document });
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);
}
