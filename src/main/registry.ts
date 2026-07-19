export interface ServiceDef {
  id: string;
  displayName: string;
  url: string;
  selfHosted: boolean;
  origins: string[];
  /**
   * Clear this service's service worker + caches (never cookies) before the very
   * first load of each launch. Slack only: its persisted SW wedges the /client
   * navigation on cold start (see startInitialLoad in recovery.ts).
   */
  clearCachesOnStart?: boolean;
  /**
   * Path to the app WITHIN a self-hosted server, appended to a customUrl that does not
   * already include it. NextCloud Talk needs this: it is an app inside NextCloud, so the
   * server root the settings field asks for is the dashboard, not Talk. Element needs no
   * appPath — a self-hosted Element Web's own root IS the app.
   */
  appPath?: string;
  /**
   * A server address is mandatory, because this service has no usable default. Talk only:
   * its `url` above is a placeholder, since there is no central NextCloud. `selfHosted`
   * says a service CAN point at your own server; this says it MUST. Element is selfHosted
   * but not serverRequired — it ships a real default (app.element.io), and most people
   * will use it.
   */
  serverRequired?: boolean;
}

export const SERVICES: readonly ServiceDef[] = [
  { id: 'whatsapp', displayName: 'WhatsApp', url: 'https://web.whatsapp.com/', selfHosted: false, origins: ['https://web.whatsapp.com'] },
  { id: 'messenger', displayName: 'Messenger', url: 'https://www.facebook.com/messages/', selfHosted: false, origins: ['https://www.facebook.com'] },
  { id: 'slack', displayName: 'Slack', url: 'https://app.slack.com/client/', selfHosted: false, origins: ['https://app.slack.com'], clearCachesOnStart: true },
  { id: 'telegram', displayName: 'Telegram', url: 'https://web.telegram.org/a/', selfHosted: false, origins: ['https://web.telegram.org'] },
  { id: 'element', displayName: 'Element', url: 'https://app.element.io/', selfHosted: true, origins: ['https://app.element.io'] },
  { id: 'talk', displayName: 'NextCloud Talk', url: 'https://example.invalid/', selfHosted: true, origins: [], appPath: '/apps/spreed/', serverRequired: true },
];

export function listServices(): readonly ServiceDef[] {
  return SERVICES;
}

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

/**
 * The URL to actually load for a service, given the server the user typed.
 *
 * Two normalisations, both driven by what the settings field asks for ("Server URL",
 * placeholder `cloud.example.com`):
 *
 * - **Scheme.** The placeholder is a bare host, so that is what users type; handing
 *   `loadURL` a scheme-less string is an outright ERR_INVALID_URL.
 * - **App path.** A service whose app lives inside the server (`appPath`) must not load
 *   the server root — for NextCloud Talk that is the dashboard, not Talk. The path is
 *   appended to whatever the user gave, so a NextCloud in a subdirectory still works, and
 *   is skipped when they already included it.
 *
 * Unparseable input is returned untouched: the recovery overlay explains a failed load
 * far better than a silently rewritten URL would.
 */
export function effectiveUrl(service: ServiceDef, customUrl?: string): string {
  const raw = customUrl?.trim();
  if (!service.selfHosted || !raw) return service.url;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw;
  }

  const appPath = service.appPath;
  if (appPath && !url.pathname.includes(appPath.replace(/\/+$/, ''))) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${appPath}`;
  }
  return url.href;
}
