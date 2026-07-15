# Electron Loft — Autostart: derived + portal — Design

Status: approved (Keith, 2026-07-15). Branch: `electron-rewrite`. NOT merged to main.

Follows service-view recovery (HEAD `5a1bd53`). Fixes a **live regression against Loft v1**: services set to
open at login do not open at login.

## 1. Why

Keith set `openOnStartup` on WhatsApp, Slack and Messenger. None started at login. His config was correct:

```json
"slack": { "openOnStartup": true }, "whatsapp": { "openOnStartup": true }, "messenger": { "openOnStartup": true }
```

**Root cause: `openOnStartup` is inert on its own.** It only takes effect once Loft itself has been launched,
and Loft only launches at login if a *separate* global "Start at login" toggle wrote
`~/.config/autostart/chat.loft.Loft.desktop`. That toggle was never on, so the entry never existed.

This is a **regression in mental model, not in code**. The Rust v1 wrote one autostart entry *per service*, so
"set the service to auto-start" was the whole story. The rewrite split it into one global entry plus per-service
flags, while the hub kept showing a per-service "Open on startup" checkbox that does nothing alone. Two settings
must agree; the UI implies one. The user is told the feature is on while it is off — the same silent-failure
class as the blank-service-view gap that stage 07 closed.

### 1a. A rejected root cause — recorded so it is not re-derived

An earlier analysis in this session claimed `autostartDir()` computed a sandbox-private path under Flatpak
(`$XDG_CONFIG_HOME/autostart` → `~/.var/app/chat.loft.Loft/config/autostart`) that GNOME never reads. **That is
false.** Probes from inside the sandbox proved `--filesystem=xdg-config/autostart:create` and
`--filesystem=xdg-data/applications:create` **bind-mount the host directories over the sandbox's
`$XDG_CONFIG_HOME`/`$XDG_DATA_HOME` subpaths**:

```
(in sandbox) echo probe > "$XDG_CONFIG_HOME/autostart/loft-PROBE.desktop"
(on host)    ~/.config/autostart/loft-PROBE.desktop        # ← it lands here
(in sandbox) ls "$XDG_CONFIG_HOME/autostart"               # ← shows the HOST's entries
```

`autostartDir()` and `applicationsDir()` are **correct as written**, in both Flatpak and native installs. No
path bug exists. Anyone re-reading this code should not "fix" those paths.

## 2. Resolved decisions (Keith, this session)

- **Derived autostart** — the global toggle is *removed*, not merely auto-enabled. Autostart is a consequence of
  the per-service flags. One concept, matching v1 and the obvious reading of the checkbox.
- **XDG Background portal** for the Flatpak write path — chosen *despite* the direct write working. Rationale
  (Keith): *"You should have used the portal in the first place. We don't break flatpak unless we have to."* The
  portal is the sanctioned route, lets the manifest downgrade a filesystem grant, keeps Flathub viable, and
  writes a better entry than we can by hand.
- Accepted cost: two write backends (portal under Flatpak, file otherwise) and a denial path.

## 3. The model

```
autostart entry exists   ⟺   some installed service has openOnStartup
```

```ts
/** Pure: the desired autostart state, derived from config. */
export function wantsAutostart(services: Record<string, ServiceConfig | undefined>): boolean;
```

**No new config key.** `startAtLogin` was never persisted — it was always derived from the file's existence —
and it stays that way. The per-service flags in `config.json` are the single source of truth.

## 4. Write via portal, read via file

The asymmetry is deliberate and is what keeps this small:

| | Flatpak | deb / rpm / AppImage |
|---|---|---|
| **Write** | `org.freedesktop.portal.Background.RequestBackground` | direct `.desktop` write (unchanged) |
| **Read** | `existsSync(~/.config/autostart/chat.loft.Loft.desktop)` | same |

The portal has **no getter**, but the autostart dir is bind-mounted (§1a) — so `isAutostartEnabled()` works
unchanged under both, and no state needs persisting. The portal is unreliable outside a sandbox (it needs an
app-id from `/.flatpak-info`), hence the file backend is retained for native installs rather than deleted.

Verified live on the target box (`gdbus introspect`, Fedora 44, `xdg-desktop-portal 1.22.1` +
`xdg-desktop-portal-gnome 50.0`), Background portal **version 2**:

```
RequestBackground(in s parent_window, in a{sv} options, out o handle);
SetStatus(in a{sv} options);          # already used by gnome/backgroundStatus.ts
```

Request options:

| key | value |
|---|---|
| `autostart` | `b` — the desired state |
| `commandline` | `as` — `['loft', '--minimized']` (`loft` = the manifest's `command:`) |
| `reason` | `s` — "Loft opens your messaging services when you log in." |
| `handle_token` | `s` — unique per call (see the race note below) |

Reply is **not** the method return. `handle` is a `Request` object path; the result arrives as
`org.freedesktop.portal.Request.Response(u response, a{sv} results)` — `response` 0 = success, 1 = cancelled,
2 = other; `results.autostart` (`b`) is **what was actually granted**, which is authoritative over what we asked
for. `parent_window` is `""` (an unparented dialog; Wayland parenting would need an xdg-foreign export handle
and is not worth it here).

> **Race:** subscribing to the signal only after `RequestBackground` returns can miss a fast response. Compute
> the expected path up front — `/org/freedesktop/portal/desktop/request/<SENDER>/<handle_token>`, where
> `<SENDER>` is the connection's unique name minus the leading `:` with `.` → `_` — subscribe, *then* call. The
> implementer must verify this against the live portal rather than trusting this paragraph.

### Structure

- `src/main/autostart.ts` — keeps the file backend (`autostartContent`, `isAutostartEnabled`) and gains the
  `syncAutostart(enabled, deps): Promise<void>` facade that dispatches on `isFlatpak()`. It returns no verdict
  by design: the granted state is read back from disk via `isAutostartEnabled()` (§6), so both backends are
  judged by the same evidence — the file — rather than by what each *claims* it did.
- `src/main/portal/background.ts` — **new**. `requestAutostart(enabled, deps): Promise<boolean>` (resolves to
  the *granted* state), behind an injectable deps seam so it unit-tests without a bus — matching the existing
  `systemDnd.ts` / `kwin.ts` / `helperInstall.ts` pattern. Never throws.

`org.freedesktop.portal.Background` is not GNOME-specific, so the new client does **not** live under
`src/main/gnome/`. The existing `SetStatus` client in `gnome/backgroundStatus.ts` is left where it is — moving
it is unrelated churn.

## 5. Reconcile points

`reconcileAutostart()` = `syncAutostart(wantsAutostart(config.services))`, called on:

1. an `openOnStartup` change (hub → `setServiceSetting`),
2. service add / remove,
3. **app startup, only when `wantsAutostart() !== isAutostartEnabled()`.**

(3) silently repairs every existing install — including Keith's current one — on next launch. Gating it on
"out of sync" means a granted permission is never re-requested, so there is no login-time prompt in the steady
state.

## 6. Denial must not become the new silent trap

If the portal denies, `openOnStartup` is checked while nothing starts — precisely the bug being fixed, wearing a
different hat. So:

- `HubGlobals` gains `autostartBlocked: boolean` — true when `wantsAutostart()` is true but
  `isAutostartEnabled()` is false after a sync attempt.
- The hub renders one line where the removed toggle was: *"Loft was denied permission to start at login."*

Deliberately **not** built: remembering the denial to suppress re-asking. Denial requires a deliberate user
action, and (3)'s out-of-sync gate already means we only ask when the state is genuinely wrong. A
`autostartDenied` config key can be added if it proves annoying.

## 7. Hub changes (removal, mostly)

- `src/shared/hubTypes.ts` — `HubGlobals.startAtLogin` **removed**; `autostartBlocked: boolean` added.
  `GlobalPatch.startAtLogin` **removed**.
- `src/renderer/hub/components/GlobalSettings.svelte` — the "Start at login" checkbox (line ~19) **removed**;
  the blocked-warning line added.
- `src/main/index.ts` — `startAtLogin: isAutostartEnabled()` in the hub state and the
  `patch.startAtLogin !== undefined → setAutostart(...)` handler **removed**; `reconcileAutostart()` wired to
  the three call sites in §5.

`setAutostart` keeps its current signature as the file backend, called only by `syncAutostart`.

## 8. Flatpak manifest

`chat.loft.Loft.yml`: the portal now performs the write, so the grant is needed only to *read* state:

```yaml
  - --filesystem=xdg-config/autostart:ro     # was :create
```

`--talk-name=org.freedesktop.portal.Desktop` is already present — the portal adds no new permission.
`--filesystem=xdg-data/applications:create` is **unchanged**: per-service launchers are still written directly
and no portal covers them.

## 9. Testing

**Unit (Vitest):**
- `wantsAutostart`: none set → false; one set → true; several set → true; a service with `openOnStartup: false`
  → false; empty config → false.
- `requestAutostart` against a fake bus: asserts the exact options map (`autostart`, `commandline`
  `['loft','--minimized']`, `reason`, a `handle_token`), and both response paths — `response: 0` +
  `results.autostart: true` → `true`; `response: 0` + `results.autostart: false` → **`false`** (asked-for ≠
  granted); `response: 1` (cancelled) → `false`; a bus throw → `false`, never rejects.
- `syncAutostart` dispatch with a fake env + fake backends: `FLATPAK_ID` set → portal called, file untouched;
  unset → file written, portal untouched.
- Reconcile gating: in-sync at startup → no backend call; out-of-sync → exactly one.
- `tests/autostart.test.ts` retained unchanged for the file backend.

**Manual (Keith):** with services checked, log out/in → they open minimized to tray. Uncheck all → the entry is
gone and nothing starts. Confirm `~/.config/autostart/chat.loft.Loft.desktop` carries `X-XDP-Autostart` (proof
the portal wrote it, not us).

## 10. What this delivers

"Open on startup" does what it says, with no second hidden setting — the v1 behaviour, restored. Under Flatpak
it is achieved through the sanctioned portal, and Loft gives back a filesystem write grant on the way.
