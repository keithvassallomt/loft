import { ipcRenderer } from 'electron';
import { startBadgeScanner } from './badge/scanner';
import { startDechrome } from './dechrome';

function readServiceId(): string {
  const arg = process.argv.find((a) => a.startsWith('--loft-service='));
  return arg ? arg.slice('--loft-service='.length) : '';
}

const serviceId = readServiceId();
if (serviceId) {
  startBadgeScanner(serviceId, (count) => ipcRenderer.send('service:badge', { count }));
  startDechrome(serviceId);
}
