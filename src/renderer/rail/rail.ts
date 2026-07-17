// A top-level `import type { RailItem } from '...'` is still an ImportDeclaration
// syntactically, so tsc (module: commonjs, no isolatedModules) treats the file as a
// CommonJS module and emits `Object.defineProperty(exports, "__esModule", ...)`. This
// file is loaded via `<script type="module">` in a real browser module scope, which has
// no `exports` global — that line would throw `exports is not defined` at runtime. An
// inline `import()` type query (a TypeAliasDeclaration, not an ImportDeclaration) gets
// the same type-checking without making tsc emit any module boilerplate — matching
// titlebar.ts, which stays a plain global script by having no import/export at all.
type RailItem = import('../../main/railModel').RailItem;

const root = document.getElementById('rail')!;

const initials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function render(items: RailItem[]): void {
  root.replaceChildren(
    ...items.map((item) => {
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
    }),
  );
}

window.loftRail.onState(render);
