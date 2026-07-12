export function resolveIconUrl(icon: string, pageHref: string): string {
  if (typeof icon !== 'string' || !icon) return '';
  if (icon.startsWith('data:')) return icon;
  if (icon.startsWith('blob:')) return ''; // read via blobToDataUri instead
  let abs = icon;
  if (!/^https?:/.test(icon)) {
    try { abs = new URL(icon, pageHref).href; } catch { return ''; }
  }
  return /^https?:\/\//.test(abs) ? abs : '';
}

export function pickTalkAvatarSrc(doc: Document, title: string): string {
  if (typeof title !== 'string') return '';
  let best: { name: string; src: string } | null = null;
  for (const span of Array.from(doc.querySelectorAll('.conversation-icon__avatar[title]'))) {
    const name = span.getAttribute('title');
    const src = span.querySelector('img')?.getAttribute('src') ?? null;
    if (name && src && title.includes(name) && (!best || name.length > best.name.length)) best = { name, src };
  }
  return best ? best.src : '';
}

export function slackSenderFromTitle(title: string): string {
  const m = typeof title === 'string' ? title.match(/^New message from (.+)$/) : null;
  return m ? m[1].trim() : '';
}

const to128 = (src: string): string => src.replace(/-\d+$/, '-128');

// Slack avatar <img> src is read via getAttribute('src') rather than the
// `.src` property: jsdom resolves `.src` against the document's base URI,
// which mangles bare `https://host/path` test fixtures, while live Chromium
// avatar URLs are already absolute `https://ca.slack-edge.com/...` so the
// attribute and the property agree in production. Reading the attribute
// keeps this helper's behaviour identical in both environments.
function slackAvatarImg(scope: ParentNode): string | null {
  const img = scope.querySelector('.c-base_icon__width_only_container img[src*="slack-edge"]');
  const src = img?.getAttribute('src') ?? null;
  return src && src.startsWith('https://') ? src : null;
}

export function scanSlackAvatars(doc: Document, cache: Map<string, string>): void {
  for (const msg of Array.from(doc.querySelectorAll('[data-msg-ts]'))) {
    const name = msg.querySelector('[data-qa="message_sender_name"]')?.textContent?.trim();
    if (!name || cache.has(name)) continue;
    const src = slackAvatarImg(msg);
    if (src) cache.set(name, to128(src));
  }
}

export function findSlackAvatar(doc: Document, cache: Map<string, string>, title: string, tag: string): string {
  if (tag) {
    const ts = tag.replace(/^tag_/, '');
    const el = doc.querySelector(`[data-msg-ts="${ts}"]`);
    const src = el ? slackAvatarImg(el) : null;
    if (src) return to128(src);
  }
  const sender = slackSenderFromTitle(title);
  if (sender && cache.has(sender)) return cache.get(sender)!;
  if (sender) {
    for (const ch of Array.from(doc.querySelectorAll('.p-channel_sidebar__channel--unread'))) {
      const nameSpan = ch.querySelector('.p-channel_sidebar__name > span:first-child');
      if (nameSpan?.textContent?.trim() !== sender) continue;
      const src = slackAvatarImg(ch);
      if (src) return to128(src);
    }
  }
  return '';
}

export async function blobToDataUri(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  try {
    const resp = await fetchFn(url);
    const blob = await resp.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}
