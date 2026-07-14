// Keep in step with the Chromium major that Electron bundles (Electron 43 → Chromium 150).
export const CHROME_VERSION = '150.0.7871.100';

export function chromeUserAgent(version: string = CHROME_VERSION): string {
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
}
