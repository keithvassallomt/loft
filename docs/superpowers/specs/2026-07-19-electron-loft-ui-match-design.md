# Electron Loft — UI Match: real service icons and view-appropriate chrome

**Status:** design approved (2026-07-19), pending implementation plan.

Brings the shipped UI up to the visual prototype (`dev_local/electron_mockups/`): real service icons everywhere a service is named, and titlebar chrome that suits the view it is sitting in.

## Why

Two gaps between the prototype and what ships:

- **Services are represented by initials placeholders** (`M`, `W`, `S`) in the rail, and by nothing at all in the manager's Configure list. The prototype shows real logos, and the machinery to serve them already exists — `loft://icon/<id>` is registered in `index.ts`, the rail's CSP already permits `img-src loft:`, the rail's own home button already renders one, and `AvailableTile.svelte` already uses it for the Add grid. The rail and the Configure list were simply never given it.
- **The titlebar shows service-only controls in the manager view.** Reload and the two zoom buttons act on a service's web view; in the manager view there is no such view, so they are dead controls. The prototype also shows a service icon beside the name, which the titlebar has never had.

**Note on the mockups:** `02-hub-window.png` predates the 09c-1 manager redesign and shows the old Installed-list + Available-tiles hub. It is a reference for *look* (icon treatment, sizing), **not** for layout — the master-detail manager stands.

## Decisions

### Scope — five changes

1. Rail icons (real logos, initials fallback).
2. Greyscale + dimmed sleeping state in the rail.
3. Service icons in the manager's Configure list and detail header.
4. Manager footer (Settings / About / Quit Loft) vertically stacked, with a divider above it.
5. Titlebar: service icon beside the name, and service-only controls hidden in the manager view.

### One signal for the titlebar, not two

Hiding the service-only controls and showing the service icon are the **same condition** — the manager view wants neither, a service view wants both. So this adds one channel, not two:

**`titlebar:set-context`**, carrying `string | null`: the id of the service this titlebar represents, or `null` for the manager view.

- `serviceWindow` sends `def.id` — a detached window always shows a service.
- `loftWindow`'s `refreshTitlebar` sends the active service id, or `null` when the manager is showing.
- The renderer: an id ⇒ show `loft://icon/<id>` and the reload / `A▾` / `A▴` buttons; `null` ⇒ hide all four.

`⇤` keeps its existing, separate `titlebar:set-attachable` logic. "Is this a detached window" is a genuinely different question from "is this showing a service" — the Loft window with a service tab active wants the icon and the controls but must **not** offer attach. Folding them would be wrong.

Close (`✕`) is always shown.

### Icon failure degrades, never blanks

The rail falls back to the existing initials span if the image errors, so a missing icon looks like today rather than an empty chip. The manager surfaces hide the image on error instead — matching what `AvailableTile.svelte` already does — because the service name is rendered right beside it there and carries the meaning on its own.

### The rail chip stays

The icon goes *inside* the existing `.item` container rather than replacing it. That container carries the active-tab affordance (`box-shadow: inset 3px 0 0`) and the badge/mark anchors, so removing it would cost the selected-tab indicator.

Sleeping becomes `filter: grayscale(1)` + reduced opacity on the whole `.item`, replacing the dashed border — which existed only to make a *text* placeholder look distinct and reads as noise beside a real logo. Greying the whole item also greys the `⧉`/`🌙` marks, which is correct. Sleeping services are already badge-gated to 0, so no live count is desaturated.

## Non-goals

- **Reverting the manager to the mockup's Installed/Available layout** — superseded by 09c-1.
- **New icon assets or an icon picker.** This uses the PNGs already shipped in `assets/icons/` and deployed to `iconsDir()`.
- **Restyling the manager beyond items 3 and 4.**
- **Touching the tray or notification icons** — they have their own paths and are unaffected.

## Components

| Unit | Change |
|---|---|
| `src/renderer/rail/rail.ts` | `serviceButton` renders an `<img>` instead of the initials span, with an `error` handler that restores the initials. Stays import-free. |
| `src/renderer/rail/rail.css` | `.icon` sizing; `.item.sleeping` becomes greyscale + dimmed, dashed border removed. |
| `src/renderer/hub/App.svelte` | Configure list entries gain an icon; `.foot` becomes a flex column with a `border-top` divider. |
| `src/renderer/hub/components/ServiceDetail.svelte` | Detail header gains an icon beside the name. |
| `src/renderer/titlebar/index.html` | An `<img id="icon" hidden>` in `.left`, before the name. |
| `src/renderer/titlebar/titlebar.css` | Icon sizing + alignment. |
| `src/renderer/titlebar/titlebar.ts` | `onSetContext` shows/hides the icon and the three service-only controls. |
| `src/renderer/titlebar/window.d.ts` | `onSetContext` signature. |
| `src/preload/titlebar.ts` | `onSetContext(cb: (id: string \| null) => void)`. |
| `src/main/loftWindow.ts` | `refreshTitlebar` sends `titlebar:set-context` (active id, or `null` for the manager). |
| `src/main/serviceWindow.ts` | Sends `titlebar:set-context` with `def.id` on titlebar load. |

No changes to `managerModel.ts` — `managerNav` already returns each service's `id`, which is all the icon URL needs.

## Error handling and edge cases

- **Missing icon** — rail falls back to initials; manager surfaces hide the image. Neither leaves a broken-image glyph.
- **Titlebar before its first push** — `#icon` starts `hidden` in the markup, and the service-only controls start visible (today's behaviour), so a titlebar that has not yet received a context renders as it does now rather than blank.
- **Renderer reload** — `loftWindow` already re-pushes titlebar state on `did-finish-load` (`refreshAll`), so the context is re-sent; `serviceWindow` likewise sends on its titlebar's `did-finish-load`.
- **Manager selected while a service tab exists** — the context is driven by `active`, not by whether any service is loaded, so switching to the manager hides the controls even with services running.

## Testing

**Honest limitation:** this slice has almost no unit-test seam. `rail.ts` is import-free by constraint; the titlebar preload calls `contextBridge` at import time with no injectable factory (unlike `buildRailBridge`); and there is no Svelte component test infrastructure — only pure model logic (`managerModel`, `hubState`) is unit-tested, and this slice changes none of it. The one candidate rule, "should the service controls show", is literally `id !== null` and does not warrant a module.

Verification is therefore:

- `npm run build` — clean.
- `npm run check` — svelte-check for the hub renderer.
- `npm test` — must stay green (no behaviour it covers should change).

**Manual smoke (Keith)**
- Rail shows real logos for every installed service; a sleeping service is grey and dimmed; the active tab still shows its selected indicator; badges and `⧉`/`🌙` marks still render.
- Manager: icons beside each Configure entry and in the detail header; Add grid unchanged.
- Manager footer: Settings / About / Quit Loft stacked vertically with a divider above them.
- Manager view: no reload, no `A▾`/`A▴`; `✕` still present and still hides to tray.
- A service tab in the Loft window: icon beside the name, reload and both zoom buttons present and working.
- A detached service window: icon beside the name, controls present, `⇤` still present.
