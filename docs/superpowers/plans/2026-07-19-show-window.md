# "Show Window" Menu Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Show Window** entry at the top of both tray menus — above the global Do Not Disturb toggle — that shows the Loft window without changing what it is showing.

**Architecture:** A new root D-Bus method `ShowWindow()` does what `ShowHub()` does minus the `showManager()` call, so the window returns to whatever tab it was on. Both menu backends get a static item wired to it: the SNI menu through its existing action-id dispatch, and the GNOME panel menu through the same root-object call it already uses for Settings.

**Tech Stack:** TypeScript, Electron 43, `dbus-next`, Vitest, plus GJS for the GNOME Shell extension. No new dependencies.

## Global Constraints

- **The action id is `show-window`.** It must NOT be `hub` or `settings` — `src/main/tray/index.ts:76` already maps both of those to `onShowHub()`, and reusing either would silently land on the manager, which is the exact behaviour this entry exists to avoid.
- **`ShowHub` keeps its current behaviour.** Settings… must still go to the manager. This adds a method; it does not change one.
- **The item goes ABOVE the global DND toggle** in both menus. Position is the whole request.
- **Static, never a toggle.** Always present, always "show" — no Show/Hide label flip.
- **`focusExternal` is required, not optional.** On Wayland a plain `open()` is subject to focus-stealing prevention; every other show path in Loft routes through the GNOME helper / KWin.
- No new dependencies.
- Build with `npm run build`; tests are `npm test`.

---

### Task 1: The `ShowWindow` root method and the SNI menu entry

**Files:**
- Modify: `src/main/dbus/loftService.ts`
- Modify: `src/main/tray/dbusMenu.ts`
- Modify: `src/main/tray/index.ts`
- Modify: `src/main/index.ts`
- Test: `tests/dbusMenuIds.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the `ShowWindow` method on the `chat.loft.Loft` root object (no arguments), which Task 2's GNOME extension calls by name.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dbusMenuIds.test.ts`, inside its top-level `describe` block (reuse the file's existing `running()` model helper and its `DbusMenu` import):

```ts
  it('offers Show Window above the global DND toggle', () => {
    // Position is the whole point of the entry: it must be the first thing in the menu,
    // before Do Not Disturb, not appended near Settings.
    const menu = new DbusMenu();
    menu.setModel(running());
    const [, layout] = menu.GetLayout(0, -1, []);
    const [, , children] = layout as LayoutNode;
    const labels = children.map(
      (v) => ((v.value as LayoutNode)[1]['label']?.value as string) ?? '',
    );
    expect(labels[0]).toBe('Show Window');
    expect(labels[1]).toBe('Do Not Disturb');
  });

  it('dispatches the Show Window click under its own action id', () => {
    // Not 'hub'/'settings': tray/index.ts already routes both of those to onShowHub, which
    // switches to the manager — the exact thing this entry must not do.
    const menu = new DbusMenu();
    menu.setModel(running());
    const seen: string[] = [];
    menu.onEvent = (actionId: string): void => { seen.push(actionId); };
    const [, layout] = menu.GetLayout(0, -1, []);
    const [, , children] = layout as LayoutNode;
    const showWindowId = (children[0].value as LayoutNode)[0];
    menu.Event(showWindowId, 'clicked', new dbus.Variant('s', ''), 0);
    expect(seen).toEqual(['show-window']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dbusMenuIds.test.ts`
Expected: FAIL — `labels[0]` is `'Do Not Disturb'`, not `'Show Window'`.

- [ ] **Step 3: Add the menu item**

In `src/main/tray/dbusMenu.ts`, find this block and insert the new item **before** it:

```ts
  const children: MenuNode[] = [];

  // Global DND toggle.
  children.push(
    item('Do Not Disturb', 'global:dnd', {
```

so it reads:

```ts
  const children: MenuNode[] = [];

  // Show the Loft window as it was left. Deliberately not 'settings' — that routes to
  // onShowHub, which switches to the manager first (see tray/index.ts).
  children.push(item('Show Window', 'show-window', {
    'icon-name': V('s', 'window-symbolic'),
  }));

  // Global DND toggle.
  children.push(
    item('Do Not Disturb', 'global:dnd', {
```

Then update the layout comment at the top of the file — replace:

```
 * Layout:
 *   ☑ Do Not Disturb                  (global:dnd)
```

with:

```
 * Layout:
 *   Show Window                       (show-window)
 *   ☑ Do Not Disturb                  (global:dnd)
```

- [ ] **Step 4: Dispatch the action**

In `src/main/tray/index.ts`, add to the `TrayDeps` interface, directly above the existing `onShowHub(): void;` member:

```ts
  /** Show the Loft window without changing which tab it is on. */
  onShowWindow(): void;
```

and in the `menu.onEvent` handler, add this line directly above the existing `hub`/`settings` line:

```ts
    if (actionId === 'show-window') return deps.onShowWindow();
```

- [ ] **Step 5: Add the D-Bus method**

In `src/main/dbus/loftService.ts`, add to `LoftServiceDeps` (the interface at the top of the file) directly below its `showHub` member:

```ts
  /** Show the Loft window without switching to the manager. */
  showWindow(): void;
```

Add the method to `LoftRootObject`, directly below `ShowHub`:

```ts
  ShowWindow(): void { this.deps.showWindow(); }
```

and its signature entry, directly below the `ShowHub` line in `configureMembers`:

```ts
    ShowWindow: { inSignature: '', outSignature: '' },
```

- [ ] **Step 6: Wire both consumers in main**

In `src/main/index.ts`, in the `loftDeps` object passed to `startLoftDbusService`, add directly below the existing `showHub` line:

```ts
        // No showManager(): the window comes back on whatever tab it was on, which is the
        // whole difference from ShowHub. focusExternal is required — a plain open() is
        // subject to Wayland's focus-stealing prevention.
        showWindow: () => { loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
```

Then find the object literal passed to the tray as `TrayDeps` (it contains `onShowHub`) and add directly above that member:

```ts
    onShowWindow: () => { loft?.open(); focusExternal(LOFT_WINDOW_KEY); },
```

- [ ] **Step 7: Run the tests and build**

Run: `npm run build && npm test`
Expected: build completes with no TypeScript errors; all tests pass including the two new ones.

- [ ] **Step 8: Commit**

```bash
git add src/main tests/dbusMenuIds.test.ts
git commit -m "feat(tray): Show Window entry above global DND, backed by a root ShowWindow method"
```

---

### Task 2: The GNOME panel menu entry

**Files:**
- Modify: `gnome-shell-extension/extension.js`

**Interfaces:**
- Consumes: the `ShowWindow` method on the `chat.loft.Loft` root object (Task 1), called with no arguments.
- Produces: nothing.

**Note:** this is GJS running inside GNOME Shell, not part of the TypeScript build, so it has no unit-test seam. It is verified by the Task 3 smoke test, which requires a GNOME logout.

- [ ] **Step 1: Add the item above the global DND toggle**

In `gnome-shell-extension/extension.js`, find this block:

```js
        const globalDndItem = new PopupMenu.PopupSwitchMenuItem(
            'Do Not Disturb', this._combinedGlobalDnd
        );
```

and insert directly **above** it:

```js
        // Show the Loft window as it was left. Deliberately NOT 'ShowHub' — that switches
        // to the manager first, so it could never bring you back to the tab you were on.
        const showWindowItem = new PopupMenu.PopupMenuItem('Show Window');
        showWindowItem.connect('activate', () => {
            this._callLoftRootMethod('ShowWindow');
        });
        menu.addMenuItem(showWindowItem);
```

- [ ] **Step 2: Update the layout comment**

Directly above that block is a comment describing the layout. Replace:

```js
        // Layout, matching the SNI backend's menu (src/main/tray/dbusMenu.ts)
        //   Do Not Disturb
```

with:

```js
        // Layout, matching the SNI backend's menu (src/main/tray/dbusMenu.ts)
        //   Show Window
        //   Do Not Disturb
```

- [ ] **Step 3: Check the file parses**

Run: `node --check gnome-shell-extension/extension.js`
Expected: no output (exit 0). This catches a syntax error without needing GNOME.

- [ ] **Step 4: Confirm nothing in the TypeScript build regressed**

Run: `npm run build && npm test`
Expected: build clean; all tests pass. (This task changes no TypeScript, so this is a guard against an accidental edit elsewhere.)

- [ ] **Step 5: Commit**

```bash
git add gnome-shell-extension/extension.js
git commit -m "feat(gnome): Show Window entry above global DND in the panel menu"
```

---

### Task 3: Verify end to end

**Files:** none modified — verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: a smoke-test result.

- [ ] **Step 1: Full build and test**

Run: `npm run build && npm test`
Expected: build clean; all tests pass.

- [ ] **Step 2: Build the Flatpak**

Run:
```bash
flatpak-builder --user --disable-cache --force-clean --repo=.flatpak-repo build-dir chat.loft.Loft.yml
```
Expected: exit 0. If it fails with `rofiles-fuse … Permission denied`, clear a stale mount and retry: `rm -rf .flatpak-builder/rofiles`.

- [ ] **Step 3: Install and verify the bytes**

Run:
```bash
flatpak update --user -y chat.loft.Loft
grep -c "show-window" ~/.local/share/flatpak/app/chat.loft.Loft/current/active/files/main/dist/main/tray/dbusMenu.js
```
Expected: at least 1.

- [ ] **Step 4: Deploy the GNOME extension to the installed location**

The extension is NOT deployed by Loft — the installed copy must be updated by hand, or GNOME keeps running the old one:

```bash
cp gnome-shell-extension/extension.js ~/.local/share/gnome-shell/extensions/loft-shell-helper@loft.chat/extension.js
diff -q gnome-shell-extension/extension.js ~/.local/share/gnome-shell/extensions/loft-shell-helper@loft.chat/extension.js
```
Expected: `diff` reports nothing (files identical).

- [ ] **Step 5: Hand the smoke test to Keith**

Do NOT launch the Flatpak GUI from automation (zypak's renderer spawn breaks). Report that the build is installed and the extension deployed, then ask Keith to:

1. **Log out and back in** — GNOME Shell caches extension JS, so the panel entry will not appear otherwise. (Worth trying `gnome-extensions disable loft-shell-helper@loft.chat && gnome-extensions enable loft-shell-helper@loft.chat` first: this is a method-body change, not a module-level binding, so it may reload without a full logout.)
2. Quit and relaunch Loft.
3. Check **both** menus show **Show Window** above **Do Not Disturb** — the GNOME panel icon, and the SNI tray if he switches `trayBackend` to `sni`.
4. Select Slack, hide the window, click **Show Window** → the window returns **on Slack**, not on Settings. This is the behaviour the whole entry exists for.
5. **Settings…** / **Loft Settings…** still opens the manager.
6. Click **Show Window** while the window is already visible → it raises, rather than doing nothing or hiding.

- [ ] **Step 6: Record the result**

Once Keith confirms, append the outcome to `.superpowers/sdd/progress.md`.

---

## Self-Review

**Spec coverage.** Every decision maps to a task: the new root method and why it is not a `ShowHub` reuse (Task 1 Steps 5-6); both backends getting the item above global DND (Task 1 Step 3, Task 2 Step 1); the `show-window` action id and its dispatch (Task 1 Steps 3-4); static-never-a-toggle (both items are plain `PopupMenuItem`/`item`, no toggle state); `focusExternal` required (Task 1 Step 6, in both wirings). The spec's non-goals hold — `ShowHub` is untouched, no Hide counterpart, nothing reordered, no EGO publish. The spec's edge cases need no code: `loft?.open()` is optional-chained, `open()` is idempotent, and `focusExternal`'s clients are optional-chained already.

**Placeholders.** None — every step names an exact file, shows the exact code and where it goes, and every command states its expected output.

**Type consistency.** `showWindow(): void` on `LoftServiceDeps` and `onShowWindow(): void` on `TrayDeps` are deliberately different names because they are different interfaces with different consumers (D-Bus vs tray); both are wired in Task 1 Step 6 to the identical body. The action id string `show-window` is identical in the item (Step 3), the dispatch (Step 4) and both tests (Step 1). The D-Bus method name `ShowWindow` is identical in `LoftRootObject`, `configureMembers`, and Task 2's `_callLoftRootMethod` call.

**One deliberate asymmetry worth noting:** the two menus wire to the same behaviour by different routes — SNI through `TrayDeps.onShowWindow` (in-process), GNOME through the D-Bus `ShowWindow` method (cross-process, since the extension lives in GNOME Shell). That mirrors exactly how `Settings…` already works in both, so it follows the established pattern rather than inventing one.
