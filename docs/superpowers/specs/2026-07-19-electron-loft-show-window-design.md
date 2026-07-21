# Electron Loft — "Show Window" in the tray and panel menus

**Status:** design approved (2026-07-19), pending implementation plan.

Adds a **Show Window** entry at the top of both tray menus — above the global Do Not Disturb toggle — that shows the Loft window without changing what it is showing.

## Why

There is currently no menu entry that just shows the window. The closest is **Settings…** / **Loft Settings…**, which routes through the root D-Bus `ShowHub()`:

```ts
showHub: () => { loft?.showManager(); loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
```

It calls `showManager()` first, so it always lands on the manager. Hide the window while reading Slack, and the only way back through the menu drops you on Settings rather than on Slack. A per-service row's Show/Hide works, but there is no way to say simply "bring the window back as I left it".

## Decisions

### A new root method, not a reuse of `ShowHub`

`ShowWindow()` on the `chat.loft.Loft` root object does what `ShowHub` does **minus** the `showManager()`:

```ts
showWindow: () => { loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
```

`focusExternal` is required, not optional: on Wayland a plain `open()` is subject to focus-stealing prevention, which is exactly why every other show path in Loft routes through the GNOME helper / KWin.

`ShowHub` keeps its current behaviour — Settings… should still go to Settings.

### Both backends, because they are specified to mirror each other

`dbusMenu.ts` documents the SNI layout that the GNOME panel menu mirrors:

```
☑ Do Not Disturb          (global:dnd)
---
  [service rows]
---
  Settings…               (settings)
  Quit Loft               (quit)
```

The new item goes **above the global DND toggle** in both. Adding it to only one would make the two diverge, which this codebase treats as a defect rather than an acceptable difference.

### Static, and always "show" — never a toggle

The item is always present and always shows, exactly like `Settings…`. It is deliberately **not** a Show/Hide toggle: per-service rows already carry Show/Hide, and a whole-window item whose label flips would be a second, differently-behaving toggle in the same menu.

It needs no new state, so `TrayModel.menuModel()` is unchanged — the item is static chrome, like `Settings…` and `Quit Loft`.

## Non-goals

- **Changing `ShowHub` or the Settings… entry.**
- **A Hide Window counterpart.** Close-to-tray and the per-service rows already cover hiding; a second hide affordance earns nothing.
- **Reordering anything else** in either menu.
- **Publishing the GNOME extension to extensions.gnome.org.** Out of scope here; the repo copy and Keith's installed copy are what this slice updates.

## Components

| Unit | Change |
|---|---|
| `src/main/dbus/loftService.ts` | `ShowWindow(): void` method + its `''`/`''` signature entry, beside `ShowHub`. |
| `src/main/index.ts` | `showWindow` dep on the D-Bus service: `loft?.open(); focusExternal(LOFT_WINDOW_KEY);`. Also the tray's new `onShowWindow`. |
| `src/main/tray/index.ts` | `TrayDeps.onShowWindow()`; dispatch the `show-window` action id. |
| `src/main/tray/dbusMenu.ts` | `Show Window` item, id `show-window`, above the `global:dnd` item; update the layout comment. |
| `gnome-shell-extension/extension.js` | `Show Window` `PopupMenuItem` above the global DND item, calling the root `ShowWindow`. |

The action id is **`show-window`**. It must not be `hub` or `settings` — `src/main/tray/index.ts:76` already maps both of those to `onShowHub()`, and reusing either would silently land on the manager, which is the exact behaviour this entry exists to avoid.

## Data flow

**SNI** — click → `menu.onEvent('show-window')` → `deps.onShowWindow()` → `loft.open()` + `focusExternal`.

**GNOME panel** — click → `_callLoftRootMethod('ShowWindow')` → D-Bus root object → the same `showWindow` dep.

## Error handling and edge cases

- **The window is already visible** — `open()` is idempotent and `focusExternal` re-focuses it. Clicking the entry when nothing is hidden simply raises the window.
- **The Loft window does not exist yet** — `loft?.open()` is optional-chained, matching every other use of `loft` in `index.ts`. Nothing throws.
- **No service is loaded** — the window opens on whatever it was last showing, which for a fresh profile is the manager. That is the existing `select(undefined)` behaviour, not a special case.
- **`focusExternal` on a desktop with neither helper** — both clients are optional-chained and never throw; the window is still shown by `open()`.

## Testing

**Unit**
- `dbusMenu`: the tree contains a `show-window` item, and it sits **above** `global:dnd` (position matters — the whole request is where it goes).
- `tray/index`: the `show-window` action calls `onShowWindow` and **not** `onShowHub` — the regression that matters, given `hub`/`settings` already share a handler.

**Manual smoke (Keith)** — requires a GNOME logout for the extension half:
- SNI and GNOME panel menus both show **Show Window** above Do Not Disturb.
- Select Slack, hide the window, click Show Window → the window returns **on Slack**, not on Settings.
- **Settings…** / **Loft Settings…** still goes to the manager.
- Clicking Show Window while the window is already visible raises it rather than doing nothing or hiding it.
