// See the original note below: an inline `import()` type query keeps tsc from emitting
// module boilerplate that would throw under `<script type="module">`.
type RailItem = import('../../main/railModel').RailItem;
type RailState = import('../../main/railModel').RailState;

const root = document.getElementById('rail')!;

const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function serviceButton(item: RailItem): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'item';
  b.classList.toggle('active', item.active);
  b.classList.toggle('sleeping', item.sleeping);
  b.title = item.displayName;
  b.setAttribute('aria-label', item.displayName);
  if (item.active) b.setAttribute('aria-current', 'page');

  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = initials(item.displayName);
  b.append(g);

  if (item.badge > 0) {
    const n = document.createElement('span');
    n.className = 'badge';
    n.textContent = item.badge > 99 ? '99+' : String(item.badge);
    b.append(n);
  }
  for (const [on, cls, glyph] of [[item.detached, 'detached', '⧉'], [item.dnd, 'dnd', '🌙']] as const) {
    if (!on) continue;
    const m = document.createElement('span');
    m.className = `mark ${cls}`;
    m.setAttribute('aria-hidden', 'true');
    m.textContent = glyph;
    b.append(m);
  }

  b.addEventListener('click', () => window.loftRail.select(item.id));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); window.loftRail.menu(item.id); });
  return b;
}

function homeButton(active: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'home';
  b.classList.toggle('active', active);
  b.title = 'Loft';
  b.setAttribute('aria-label', 'Loft manager');
  if (active) b.setAttribute('aria-current', 'page');
  const img = document.createElement('img');
  img.src = 'loft://icon/loft';
  img.alt = '';
  b.append(img);
  b.addEventListener('click', () => window.loftRail.showManager());
  return b;
}

function render(state: RailState): void {
  const divider = document.createElement('div');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  root.replaceChildren(
    homeButton(state.managerActive),
    divider,
    ...state.items.map(serviceButton),
  );
}

window.loftRail.onState(render);
