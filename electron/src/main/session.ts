import type { Session } from 'electron';
import { chromeUserAgent } from './ua';

export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'mediaKeySystem',
  'notifications',
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'display-capture',
  'speaker-selection',
  'background-sync',
]);

export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

export function configureSession(ses: Session, partition: string): void {
  ses.setUserAgent(chromeUserAgent());

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission));

  // Screen share — desktopCapturer.getSources triggers the Wayland portal picker.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { desktopCapturer } = require('electron');
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources: Electron.DesktopCapturerSource[]) =>
          callback(sources[0] ? { video: sources[0] } : {}),
        )
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
}
