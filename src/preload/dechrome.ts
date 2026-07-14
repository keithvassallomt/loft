function cleanMessengerBanner(): void {
  const banner = document.querySelector('[role="banner"]');
  if (!banner) return;
  const sibling = banner.nextElementSibling;
  banner.remove();
  const nested = sibling?.querySelector('div');
  const inner = nested?.querySelector('div');
  if (inner && getComputedStyle(inner).top !== 'auto') {
    (inner as HTMLElement).style.top = '0';
    (inner as HTMLElement).style.height = '100%';
  }
}

export function startDechrome(serviceId: string): void {
  if (serviceId !== 'messenger') return;
  let t: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(cleanMessengerBanner, 300);
  };
  const start = () => {
    if (!document.body) { setTimeout(start, 500); return; }
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    setTimeout(cleanMessengerBanner, 2000);
  };
  start();
}
