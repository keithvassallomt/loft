export interface ServiceDef {
  id: string;
  displayName: string;
  url: string;
  selfHosted: boolean;
  origins: string[];
}

export const SERVICES: readonly ServiceDef[] = [
  { id: 'whatsapp', displayName: 'WhatsApp', url: 'https://web.whatsapp.com/', selfHosted: false, origins: ['https://web.whatsapp.com'] },
  { id: 'messenger', displayName: 'Messenger', url: 'https://www.facebook.com/messages/', selfHosted: false, origins: ['https://www.facebook.com'] },
  { id: 'slack', displayName: 'Slack', url: 'https://app.slack.com/client/', selfHosted: false, origins: ['https://app.slack.com'] },
  { id: 'telegram', displayName: 'Telegram', url: 'https://web.telegram.org/a/', selfHosted: false, origins: ['https://web.telegram.org'] },
  { id: 'element', displayName: 'Element', url: 'https://app.element.io/', selfHosted: true, origins: ['https://app.element.io'] },
  { id: 'talk', displayName: 'NextCloud Talk', url: 'https://example.invalid/', selfHosted: true, origins: [] },
];

export function listServices(): readonly ServiceDef[] {
  return SERVICES;
}

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function effectiveUrl(service: ServiceDef, customUrl?: string): string {
  if (service.selfHosted && customUrl && customUrl.trim().length > 0) return customUrl;
  return service.url;
}
