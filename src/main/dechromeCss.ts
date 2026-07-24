const CSS: Record<string, string> = {
  slack: '[data-qa="workspace-banner-download-app"] { display: none !important; }',
  talk:
    '#header { display: none !important; } ' +
    ':root, body { --header-height: 0px !important; } ' +
    '#content { margin: 0 !important; } ' +
    '#content-vue { width: 100% !important; height: 100% !important; border-radius: 0 !important; }',
  messenger:
    '* { --header-height: 0px !important; } ' +
    '[role="dialog"], [role="dialog"] * { --header-height: 56px !important; }',
};

export function dechromeCssFor(serviceId: string): string | null {
  return CSS[serviceId] ?? null;
}
