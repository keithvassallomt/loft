import { BADGE_PARSERS } from './parsers';

export function startBadgeScanner(serviceId: string, send: (count: number) => void): void {
  const parser = BADGE_PARSERS[serviceId];
  if (!parser) return;

  let last = -1;
  const scan = () => {
    const count = parser(document);
    if (count !== last) {
      last = count;
      send(count);
    }
  };

  // Messenger/Telegram parsers are heavier (per-anchor tree-walks); debounce their
  // mutation-driven scans like content.js does. Light services scan directly.
  const heavy = serviceId === 'messenger' || serviceId === 'telegram';
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onMutation = heavy
    ? () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(scan, 500); }
    : scan;
  const observer = new MutationObserver(onMutation);
  const observeTarget = () => {
    // Element reports its count via document.title; others via the body DOM.
    const target = serviceId === 'element' ? document.querySelector('title') ?? document.body : document.body;
    if (!target) { setTimeout(observeTarget, 500); return; }
    observer.observe(target, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
  };
  observeTarget();

  setInterval(scan, 2000);
  setTimeout(scan, 3000);
}
