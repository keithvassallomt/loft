# Multiple Accounts

Status: design
Date: 2026-07-23

## 1. Goal

Let one Loft hold **several accounts of the same service** — a personal and a work
WhatsApp, two Slack workspaces, two NextCloud Talk servers — each with its own login, its
own unread badge, its own notifications, and its own name and icon so the user can tell
them apart in the rail, the tray, the GNOME panel and the app grid.

Today a service is a single row in a static registry, and its registry id doubles as
"which app" and "which account". This splits those two ideas apart. Everything else the
user already has — grid cells, rail order, detach, per-service DND, launchers — must keep
working, and no existing config may need migrating.

## 2. Decisions

Settled during brainstorming, each with the alternative that lost:

| #  | Decision | Rejected |
|----|----------|----------|
| D1 | An account is an **instance**; its id is the config key and stays the thing every subsystem keys on. The first instance of a kind keeps the bare kind id (`whatsapp`), so nothing existing moves. | A separate `accounts` map keyed by kind; compound `kind:account` keys everywhere |
| D2 | `kind` / `name` / `icon` are **optional** fields on the existing `ServiceConfig`, absent meaning "the kind is my id, the name and icon are the kind's". No config migration, no `configVersion` bump. | A v3 migration writing the fields out explicitly |
| D3 | A second instance gets the **next unused pastel variant** for its kind, automatically. | Same brand icon until the user picks; prompt for name + icon at add time |
| D4 | Display names must be **unique**. | Allow duplicates and disambiguate in the UI only |
| D5 | The D-Bus object path is derived from the kind's *default* name plus the instance number and **never moves on rename**. | Re-derive from the current display name and re-export on every rename |
| D6 | Main **pushes the D-Bus segment** to the GNOME helper; the extension stops deriving it from the display name. | Dual-export at both a stable and a display-name path so the shipped helper needs no change |
| D7 | Icon variants are **rasterised to committed PNGs at build time**. | Rasterise at runtime; serve SVG and special-case the consumers that need PNG |
| D8 | Custom icons accept **raster files only** (PNG/JPEG/WebP). | Accept SVG too and shell out to a converter |

D4 and D5 are not tidiness. See §5.

## 3. Model: kinds and instances

**Kind** — a registry entry. `registry.ts` is unchanged in content; its exported type is
renamed `ServiceKind`. A kind owns everything that is a property of the *app*: URL,
`selfHosted`, `serverRequired`, `appPath`, `origins`, `clearCachesOnStart`, its badge
parser, its de-chroming rules, its default display name and its brand icon.

**Instance** — one account of a kind. Its **id** is the `config.services` key, and is
already what the whole app keys on:

| Keyed by instance id today | Where |
|---|---|
| session partition `persist:<id>` | `serviceView.ts`, notification avatar fetches |
| icon URL `loft://icon/<id>` | rail, grid cells, titlebar, hub |
| launcher `loft-<id>.desktop` | `desktop.ts` |
| rail order, grid tree leaves | `config.railOrder`, `config.grid` |
| badge / DND / visibility / zoom state | `index.ts` maps, tray model, notification gate |

So instances need no new plumbing in any of those; they need the id space to admit more
than one entry per kind.

### 3.1 Config

Three optional fields join `ServiceConfig`:

```ts
export interface ServiceConfig {
  /** Registry kind. Absent ⇒ the id itself — every pre-multi-account config is valid as-is. */
  kind?: string;
  /** User's display name. Absent ⇒ the kind's default. */
  name?: string;
  /** 'brand' | a variant colour key ('rose', …) | 'custom'. Absent ⇒ 'brand'. */
  icon?: string;
  // …customUrl, window, openOnStartup, dnd, badgesEnabled, detached, launcher unchanged
}
```

All three are whitelisted by `sanitizeServiceConfig` the same way the existing fields are:
present-and-a-string or dropped. A `kind` naming no registry entry is left in place and
reported by the existing phantom-service warning (§8.6) — the same treatment an unknown id
gets today.

### 3.2 Resolution

`getService(id)` becomes `resolveInstance(id)`, returning the same shape every call site
already destructures — `def.id`, `def.displayName`, `def.url`, `def.selfHosted`,
`def.appPath`, … — with `def.id` now the *instance* id, `def.displayName` now the *user's*
name, and one new field, `def.kind`. Call sites keep compiling; what changes is meaning.

```ts
export interface ServiceInstance extends Omit<ServiceKind, 'id' | 'displayName'> {
  id: string;           // instance id: 'whatsapp' | 'whatsapp-2'
  kind: string;         // registry kind id: 'whatsapp'
  displayName: string;  // config.name ?? default name for this instance
  dbusSegment: string;  // stable D-Bus object-path segment (§5.2)
  icon: string;         // 'brand' | colour key | 'custom'
}
```

`listServices()` becomes `listInstances()` — installed instances in config order. The
registry list survives as `listKinds()` for the Add galleries.

### 3.3 Instance ids

Allocated by main, never by the renderer:

- instance 1 of a kind → the bare kind id (`whatsapp`)
- instance N → `<kind>-<N>`, N the lowest integer ≥ 2 not currently in use for that kind

No cap. Ids are **not** reserved after removal: remove `whatsapp-2` and the next added
WhatsApp is `whatsapp-2` again. If the user removed it *without* deleting login data, the
new instance inherits that partition — exactly what already happens when you remove and
re-add a service today, so it is the behaviour users have.

Removing the first instance while a second exists is fine; ids are independent, and
`whatsapp-2` does not renumber.

### 3.4 Default names

Instance 1 → the kind's default name ("WhatsApp", "NextCloud Talk"). Instance N → `<default
name> <N>` ("WhatsApp 2"). If that collides with a name the user already chose, append the
next free integer until it does not — a default must never fail the uniqueness rule in §5.1.

## 4. What the user sees

### 4.1 Add another

The hub's **Add a service** page keeps its tile gallery, now listing kinds with **zero**
instances. Below a horizontal rule, an **Add another** section lists kinds that already
have at least one, using the same tiles and the same Add button.

Self-hosted kinds keep the existing server-URL modal in both sections, so a second
NextCloud Talk asks for its own server and a second Element can point at a different
homeserver. When every kind has at least one instance the top section collapses to its
existing empty state ("You've added every service Loft supports") and Add another carries
the page.

### 4.2 Name and icon

Per-service settings gains two controls, above the existing Server URL / toggles:

- **Name** — a text field. Committing an invalid name (§5.1) leaves the field's value in
  place and shows an inline reason; nothing is written.
- **Icon** — a row of swatches: the brand icon, then that kind's colour variants, then a
  **Choose a file…** button. Selecting a swatch applies immediately.

Both apply to single instances too. Renaming your only WhatsApp to "Work" is the same
operation as renaming your second one, and is worth having on its own.

A rename or icon change takes effect immediately everywhere the name and icon are already
pushed — rail, titlebar, OS window title, tray and GNOME panel menus, notification sender
name, and the `.desktop` launcher when the service has one. Nothing waits for a restart.

## 5. Identity: names, D-Bus, window matching

### 5.1 Names must be unique

A display name is valid when, after trimming, it is non-empty, at most 64 characters,
case-insensitively distinct from every *other* instance's name, and not "Loft"
(case-insensitively).

This is not cosmetic. The GNOME Shell helper and KWin both locate a window **by its
caption**, and a service window's caption *is* its display name
(`formatWindowTitle(def.displayName, count)`); "Loft" is the Loft window's own key. Two
instances sharing a name means Show/Hide/Focus reaches whichever window matched first, and
a service named "Loft" hijacks the main window. Uniqueness is what keeps window matching a
function rather than a guess.

Validation lives in main — it owns config and is the only place that sees all instances —
and is surfaced by the `hub:renameService` result (§7).

### 5.2 D-Bus paths never move

The object-path segment is derived from the **kind's default name** and the instance
number, not from the current display name:

```
dbusSegment('whatsapp')    = 'WhatsApp'         → /chat/loft/WhatsApp
dbusSegment('whatsapp-2')  = 'WhatsApp2'        → /chat/loft/WhatsApp2
dbusSegment('talk')        = 'NextCloudTalk'    → /chat/loft/NextCloudTalk
```

Three properties fall out, all of them load-bearing:

- **Existing installs keep byte-identical paths.** The documented interface in CLAUDE.md
  stays true.
- **Renaming does not break scripts or menus.** A path that tracked the display name would
  move under the user's feet every rename, and would have to be unexported and re-exported
  each time.
- **The segment is always a valid path segment.** Registry names are ASCII, so a derived
  segment is always `[A-Za-z0-9_]+`. A user-chosen name is not — "Xogħol" has no valid
  D-Bus path — and deriving from it would mean either rejecting such names or exporting
  nothing.

Objects become **per-instance and dynamic**: exported when an instance is added,
unexported when it is removed, instead of one per registry entry exported once at startup.
Uninstalled services stop having D-Bus objects, which is a fix.

### 5.3 The GNOME extension

`gnomePanel.ts` currently passes the service **id** as the helper's `name` argument, and
the helper ignores it for routing, rebuilding the path itself with
`svc.displayName.replace(/\s+/g, '')`. That works only while nobody renames anything.

Main starts pushing `dbusSegment` as `name`, and the extension uses it:

| File | Change |
|---|---|
| `src/main/tray/gnomePanel.ts` | `updateCombinedService(seg, displayName, …)` / `updateAvailableService(seg, displayName)` / `removeCombinedService(seg)`; the panel map keys on the segment |
| `gnome-shell-extension/extension.js:879` | drop `const dbusName = svc.displayName…`; call `_callDaemonMethod(svc.name, …)` |
| `gnome-shell-extension/extension.js:961` | same for the available-service launch row |

The `wm_class` argument stays the display name — window matching genuinely is by caption
(§5.1). Helper JS only takes effect after a GNOME session restart, and this needs an
extensions.gnome.org republish; until a user has it, a **renamed** service's panel-menu
actions are inert (its path no longer matches what the old helper derives). Unrenamed
services are unaffected, because for those the derived and pushed segments are identical.

KWin needs no change: it already matches by caption only.

## 6. Icons

### 6.1 Assets

`assets/icons/alt/<kind>-pastel-variants/<kind>-pastel-<colour>.svg` flattens to:

```
assets/icons/variants/<kind>-<colour>.svg    # source, committed
assets/icons/variants/<kind>-<colour>.png    # 512×512, committed, generated
```

Generated by a new `npm run icons` (ImageMagick with its rsvg delegate, verified to
produce clean output at 512). Rasterising at build time rather than at runtime is not
optional: `.desktop` `Icon=`, the SNI tray pixmap and `org.freedesktop.Notifications` all
need a real PNG on disk, and Electron's `nativeImage` cannot load SVG.

`palette.json` is dropped rather than moved — it omits `butter`, which five of the six
kinds actually ship, so it is already wrong, and a capitalised colour key ("Rose",
"Butter") is a perfectly good swatch label. The kinds do not share a variant set
(WhatsApp has no mint, Slack no apricot), so main **scans the variants directory once at
startup** to build kind → available colours and includes it in hub state. Adding a variant
later is then a file drop plus a rebuild.

### 6.2 Assignment

Instance 1 → `brand`. Instance N → the first colour in its kind's variant list (sorted) not
already used by a sibling instance of that kind; if all are taken, cycle from the start. The
user can change it afterwards, including back to `brand`.

### 6.3 Deployment and resolution

Adding an instance, or changing its icon, writes `~/.local/share/loft/icons/<id>.png`.
Today that happens only when a launcher is created — which would leave `whatsapp-2` with no
icon file at all and a broken image in the rail, since there is no bundled
`whatsapp-2.png` to fall back to. Removing an instance deletes the file.

Both icon consumers gain the same fallback chain, so a failed or missing copy degrades to
the right logo rather than a blank:

1. `iconsDir/<id>.png` — the deployed instance icon
2. the instance's variant PNG, when `icon` is a colour key
3. `assets/icons/<kind>.png` — the brand icon
4. `assets/icons/<name>.png` — unchanged, and still what serves `loft://icon/loft` and the
   not-yet-added kinds in the Add gallery

`serviceIconPath(id)` (notifications) follows the same chain; it currently reads the
bundled asset only.

### 6.4 Custom icons

**Choose a file…** opens a main-process file dialog filtered to PNG, JPEG and WebP. The
picked file is read through `nativeImage`, resized to 512×512, and written as the
instance's icon PNG; `config.icon` records `'custom'`. Nothing keeps a reference to the
source file, so moving or deleting it later is harmless.

SVG is deliberately not accepted. Electron cannot rasterise it, and shelling out to a
converter the user may not have installed turns "pick an icon" into a silent failure on
some machines.

## 7. IPC and hub state

`HubState` splits along the same seam as the model:

```ts
interface HubState {
  services: HubService[];   // INSTANCES, installed only
  kinds: HubKind[];         // registry kinds + how many instances each has
  globals: HubGlobals;
}

interface HubService {      // …existing fields, plus:
  kind: string;
  icon: string;             // 'brand' | colour key | 'custom'
  variants: string[];       // colour keys available for this kind
}

interface HubKind {
  id: string; displayName: string;
  selfHosted: boolean; serverRequired: boolean; defaultUrl: string;
  instanceCount: number;    // 0 ⇒ "Add a service"; ≥1 ⇒ "Add another"
}
```

`HubService.installed` goes away — an entry in `services` *is* an installed instance, and
the Add galleries now read `kinds`.

Channels:

| Channel | Shape | Notes |
|---|---|---|
| `hub:addService` | `on(kind, customUrl?)` | argument is now a **kind**; main allocates the instance id |
| `hub:renameService` | `invoke(id, name) → {ok} \| {error}` | can fail (§5.1), so it must return |
| `hub:setServiceIcon` | `invoke(id, choice) → {ok} \| {error}` | `choice` is `'brand'`, a colour key, or `'custom'`; `'custom'` opens the dialog in main. A cancelled dialog returns `{ok}` and changes nothing — cancelling is not an error |

`hub:removeService`, `hub:setServiceSetting`, `hub:openService` and `hub:recoverService`
keep their shapes; their `id` is an instance id, which is what it already was.

## 8. Downstream

### 8.1 Free

Rail and rail order, grid cells and the grid tree, badges, per-service DND, zoom, detach
and re-attach, close-to-tray, per-instance login (separate `persist:<id>` partitions),
notification avatars (fetched through that instance's own authenticated session),
notification click-to-navigate, recovery overlay. All of these key on the instance id and
read the display name through the resolver.

### 8.2 Launchers

`serviceLauncherContent` takes the instance: `Name=` and `Comment=` use the user's name,
`Icon=` the deployed instance PNG, `Exec=… --service=<instanceId>`. The filename is
already `loft-<id>.desktop`. A rename or icon change rewrites the launcher when the
service has one, so it does not go stale until next launch.

### 8.3 Tray, SNI, GNOME panel

Seeded from instances rather than the registry; labels are display names, which they
already were. The GNOME panel additionally pushes the D-Bus segment (§5.3). Per-service
rows in both menus are text-only, so no per-instance icon is needed there.

### 8.4 Preload

`additionalArguments: ['--loft-service=<kind>']` — the **kind**, not the instance id. That
argument selects the badge parser, the Messenger/Telegram DOM-scrape-only notification
rule, the Slack avatar scanner, the Talk avatar picker and the Messenger de-chroming; all
of those are properties of the app, not the account. Routing back to main is by
`webContents`, not by id, so nothing else in the preload needs the instance.

For every existing service kind and id are equal, so this is a no-op until a second
instance exists — which is precisely why it must be changed deliberately rather than left
to coincidence.

### 8.5 CLI

`--service=<id>` takes an instance id. A bare kind id still resolves, because instance 1
keeps it. An id naming no instance behaves as it does today (no service opened).

### 8.6 Startup checks

The phantom-service warning and the grid prune currently iterate the registry; both move to
instances. The warning's wording changes from "no such service in the registry" to naming
the unresolvable **kind**, since that is now what is missing.

## 9. Testing

Vitest over the pure pieces:

- instance id allocation: first is bare, second is `-2`, gap reuse, removal then re-add
- kind resolution from a legacy config (no `kind` field) and from an explicit one
- default name generation, including the collision fallback
- name validation: empty, whitespace-only, too long, duplicate (case-insensitive), "Loft"
- `dbusSegment` derivation, and that it is unchanged across a rename
- variant auto-assign: first unused colour, cycling when exhausted, per-kind sets
- the icon fallback chain, deployment on add/change, deletion on remove
- launcher content for a renamed instance with a custom icon
- hub state shape: instances vs kinds, `instanceCount` driving the two galleries
- config sanitization of `kind` / `name` / `icon`, including a non-string and a `__proto__` key

`svelte-check` for the hub renderer.

Manual checklist: two WhatsApps logged into different accounts, both badging independently;
both present in the rail, tray menu and GNOME panel menu; one renamed and given a custom
icon, then Loft restarted; a second NextCloud Talk pointed at a different server; a renamed
instance's launcher opening the right account; both instances tiled in the grid at once;
removing one leaving the other's login intact.

## 10. Out of scope

- Reordering or grouping instances beyond what `railOrder` already does
- Per-instance notification sounds, or any per-instance setting not already per-service
- Sharing a login between instances of the same kind
- Any change to how a kind is defined — the registry stays a hand-edited list
