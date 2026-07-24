# Electron Loft 09c-3 — Polish grab-bag

**Status:** design approved (2026-07-18), pending implementation plan.

The third 09c slice: three independent near-defects, each small and self-contained. (09c-1 manager redesign is done; 09c-2 live-view detach is separate.)

## Why

Three real defects surfaced while mapping 09c:

1. **The launcher opt-out is ignored.** `LoftConfig.services[].launcher` exists (`config.ts:29`) but the startup self-heal (`index.ts:765-770`) writes a per-service `.desktop` for **every** installed service unconditionally, never reading the flag. `removeServiceLauncher` (`desktop.ts:111`) is only ever called on explicit Remove. So a user can't opt a service out of having its own launcher, and the unified-view intent (spec 09 Q2 — per-service launchers are opt-in, one Loft launcher is the norm) isn't realised.
2. **Telegram notification clicks do nothing.** Telegram's scanner produces an `href` (`telegram.ts:102`), the bridge sends it and main delivers it back as `service:navigate`, but the preload handler hard-gates `if (serviceId !== 'messenger') return` (`bridge.ts:93`) — so the href is silently dropped.
3. **Every badge tick repaints twice.** `service:badge` (`index.ts:586-602`) calls `loft?.refreshRail()` (which is `refreshAll` — rail + titlebar + window title) and then `sw.setBadge(count)`, whose attached-host implementation calls `refreshAll` again (`loftWindow.ts:252,322-327`). Separately, `hostFor(id)` (`loftWindow.ts:241-261`) rebuilds a fresh ~13-closure object on every call, and `hostOf` routes every attached-service lookup through it.

## Decisions

- **Launcher: opt-in, off by default, and enforced (spec 09 Q2).** New services default `launcher: false`. The per-service settings pane gets a "Create a desktop launcher" toggle. Toggling applies immediately (write/remove the `.desktop`); the startup sweep re-enforces on every launch. Existing services keep their launchers — migration already back-filled them `launcher: true` (`migrate.ts:30`).
- **Telegram navigate: ungate + a per-service fallback.** The anchor-click is shared (it already matches Telegram chat-row hrefs); only the full-navigation fallback stays service-specific.
- **Perf: memoize `hostFor` per id; one repaint per badge tick.** Both are internal, behaviour-preserving.

## Non-goals

- Per-service deeplinks for Slack/Element/Talk/WhatsApp — separate research spec. This slice only unblocks Telegram (its href already arrives).
- Live-view detach, reattach, drag-to-detach — 09c-2.
- Any change to how the **Loft** launcher (`chat.loft.Loft.desktop`, `ensureHubDesktopEntry`) is written — unaffected.

## Component design

### 1. Launcher: opt-in + enforced

- **Config/data:** `HubService` and `ServicePatch` (`src/shared/hubTypes.ts`) gain `launcher: boolean` / `launcher?: boolean`. `buildHubState` (`src/main/hubState.ts`) maps `launcher: c?.launcher === true` (absent = false, matching `config.ts:29`).
- **Add default:** `install.ts` stops setting `launcher: true` on Add (new services are launcher-less until opted in). Existing back-fill in `migrate.ts` is unchanged, so already-installed services stay `true`.
- **Toggle UI:** `ServiceDetail.svelte` gains a "Create a desktop launcher" toggle bound to `svc.launcher`, calling `set({ launcher })` (the existing per-service settings path).
- **Immediate apply:** `setServiceSetting(id, patch)` in `index.ts` — after persisting, if `patch.launcher !== undefined`, write the launcher when `true`, remove it when `false`. (`writeServiceLauncher` keeps its existing dev-run guard at `desktop.ts:100-103`; in an unpackaged dev run nothing is written, which is correct.)
- **Startup sweep:** the loop at `index.ts:765-770` becomes: for each installed service, `writeServiceLauncher(...)` when `config.services[id].launcher === true`, else `removeServiceLauncher(...)`. This is what makes the opt-out real — an opted-out service's stale `.desktop` is cleaned up on next launch.

### 2. Telegram deeplink unblock

- `bridge.ts`'s `service:navigate` handler (`bridge.ts:92-105`) drops the `serviceId !== 'messenger'` gate. Flow:
  - Try the shared anchor-click: `doc.querySelector('a[href="<url>"]')?.click()` (wrapped in the existing try/catch for malformed selectors). This is the normal path for both Messenger and Telegram — the chat row is a live `<a href>`.
  - If no anchor matched, fall back per service: Messenger → `win.location.href = 'https://www.facebook.com' + url` (unchanged); Telegram → if `url` is a hash route (`#…`), `win.location.hash = url`, else no-op. A service with no fallback (none today besides these two) simply does the anchor-click and stops.
- No new channel; no change to what the scanners send.

### 3. Badge-path perf

- **Memoize `hostFor`:** cache the per-id host object in a `Map` inside `loftWindow`; return the cached object on repeat calls; invalidate the entry on `attach`/`detach`/`unload` for that id. The host object's methods close over `id` + `sv`, so a cached instance stays valid for the life of that view.
- **One repaint per badge tick:** the explicit `loft?.refreshRail()` in the `service:badge` handler already repaints the whole Loft window (rail + titlebar + window title) for the attached service whose badge changed, and it is *also* required for a **detached** service (whose rail entry lives in the Loft window while its view lives elsewhere). The second repaint comes from the attached-host `setBadge → refreshAll`. Resolve by making the attached-host `setBadge` stop triggering its own `refreshAll` (the count lives in `index.ts`'s `currentBadge`, which `deps.badge` reads, so the already-scheduled `refreshRail` renders the new value). Detached hosts (`ServiceWindow`) keep their own `setBadge`, which updates their separate window — untouched. Net: one Loft-window repaint per tick, plus the detached window's own update when applicable.

## Data flow (launcher)

```
Add a service ─▶ install (launcher NOT set ⇒ false) ─▶ no .desktop written
Settings toggle ─▶ hub:setServiceSetting {launcher} ─▶ setServiceSetting persists + writes/removes the .desktop now
Every startup ─▶ sweep: launcher===true ? writeServiceLauncher : removeServiceLauncher   (enforces the flag)
```

## Testing

- **install:** a newly added service has `launcher !== true` (opt-in off); Remove still removes the launcher.
- **launcher sweep (pure helper):** given a services map, the sweep writes for `launcher===true` ids and removes for the rest — assert against injected `write`/`remove` spies (extract the decision into a small pure function so it's testable without touching the filesystem, mirroring the codebase's seam pattern).
- **buildHubState:** `launcher` reflects `config.services[id].launcher === true` (absent ⇒ false).
- **navigate strategy:** a small pure `navigateAction(serviceId, url, hasAnchor)` (or equivalent) returns `click` when an anchor matches, else the per-service fallback (`messenger`→facebook full-nav, `telegram`→hash, unknown→none); unit-tested. The bridge handler calls it.
- **perf:** existing badge/notify tests stay green (behaviour unchanged). A focused test that a single `service:badge` produces one rail refresh is desirable but `index.ts`/`loftWindow.ts` aren't vitest-importable — cover the dedup by the pure host-memoization where it can be isolated, and rely on the existing suite + smoke for the wiring.
- **svelte-check** for the `ServiceDetail` toggle.

## Edge cases

- **Existing install, first launch after this ships:** migration back-filled `launcher: true`, so the sweep keeps every existing service's launcher — no surprise disappearance. Only *new* opt-in-off adds go launcher-less.
- **Dev run (unpackaged):** `writeServiceLauncher`'s dev guard means the toggle/sweep write nothing; `removeServiceLauncher` still cleans an existing file. Correct — a dev launcher would point at the wrong binary.
- **Telegram Web K rows without an `<a href>`:** the notifier falls back to `data-peer-id`/text as the key (`telegram.ts:71`); such a key won't match an anchor and has no hash fallback, so the click is a no-op rather than a wrong navigation. Acceptable — no regression (today it does nothing at all).
- **Detached service badge:** its rail entry still updates (the explicit `refreshRail` remains); its own window still updates via its own host `setBadge`.

## File-level impact (orientation for the plan)

- `src/shared/hubTypes.ts` — `launcher` on `HubService` + `ServicePatch`.
- `src/main/hubState.ts` — map `launcher`.
- `src/main/install.ts` — drop `launcher: true` on Add.
- `src/main/index.ts` — `setServiceSetting` applies a `launcher` change; the startup sweep gates write-vs-remove on the flag (extract the sweep decision into a pure helper for testing).
- `src/renderer/hub/components/ServiceDetail.svelte` — the toggle.
- `src/preload/notify/bridge.ts` — generalized `service:navigate` (+ a pure `navigateAction` helper).
- `src/main/loftWindow.ts` — memoized `hostFor`; attached-host `setBadge` no longer double-repaints.
- Tests: `install.test.ts` (default off), a new sweep-decision test, `hubState.test.ts` (launcher field), a new navigate-strategy test.
