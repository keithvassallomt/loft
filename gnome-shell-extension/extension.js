// SPDX-License-Identifier: GPL-3.0-or-later
// Loft Shell Helper — D-Bus + shell integration for the Loft daemon.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';
import {AppSwitcherPopup} from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DBUS_NAME = 'chat.loft.ShellHelper';
const DBUS_PATH = '/chat/loft/ShellHelper';

// Chrome in --app= mode sets WM_CLASS to "chrome-<sanitised_url>-<profile>".
const LOFT_WM_CLASS_LIST = [
    'chrome-web.whatsapp.com__-Default',
    'chrome-facebook.com__messages_-Default',
    'chrome-app.slack.com__client_-Default',
    'chrome-web.telegram.org__a_-Default',
];

const DBUS_IFACE = `<node>
  <interface name="${DBUS_NAME}">
    <method name="FocusWindow">
      <arg name="wm_class" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="HideWindow">
      <arg name="wm_class" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="RegisterService">
      <arg name="name" type="s" direction="in"/>
      <arg name="display_name" type="s" direction="in"/>
      <arg name="icon_name" type="s" direction="in"/>
      <arg name="wm_class" type="s" direction="in"/>
    </method>
    <method name="UnregisterService">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="UpdateBadge">
      <arg name="name" type="s" direction="in"/>
      <arg name="count" type="u" direction="in"/>
    </method>
    <method name="UpdateDnd">
      <arg name="name" type="s" direction="in"/>
      <arg name="enabled" type="b" direction="in"/>
    </method>
    <method name="UpdateVisible">
      <arg name="name" type="s" direction="in"/>
      <arg name="visible" type="b" direction="in"/>
    </method>
    <method name="RegisterCombined">
      <arg name="icon_name" type="s" direction="in"/>
    </method>
    <method name="UnregisterCombined"/>
    <method name="UpdateCombinedService">
      <arg name="name" type="s" direction="in"/>
      <arg name="display_name" type="s" direction="in"/>
      <arg name="visible" type="b" direction="in"/>
      <arg name="badge" type="u" direction="in"/>
      <arg name="dnd" type="b" direction="in"/>
      <arg name="wm_class" type="s" direction="in"/>
    </method>
    <method name="RemoveCombinedService">
      <arg name="name" type="s" direction="in"/>
    </method>
  </interface>
</node>`;

// Saved originals — restored in disable().
const _origIsOverviewWindow = Workspace.prototype._isOverviewWindow;
const _origAppSwitcherInit = AppSwitcherPopup.prototype._init;
const _origAppSwitcherInitialSelection = AppSwitcherPopup.prototype._initialSelection;
const _origGetRunning = Shell.AppSystem.prototype.get_running;
const _origGetWindowApp = Shell.WindowTracker.prototype.get_window_app;
const _origGetFocusApp = Shell.WindowTracker.prototype.get_focus_app;
const _origAppGetWindows = Shell.App.prototype.get_windows;
const _origAppActivate = Shell.App.prototype.activate;
const _origAppActivateWindow = Shell.App.prototype.activate_window;

function _isLoftWindow(win, wmClasses) {
    let meta = win;
    if (win.get_meta_window)
        meta = win.get_meta_window();
    const wmClass = meta.get_wm_class?.() ?? '';
    return wmClasses.has(wmClass);
}

function _isMinimizedLoftWindow(win, wmClasses) {
    const wmClass = win.get_wm_class?.() ?? '';
    return wmClasses.has(wmClass) && win.minimized;
}

export default class LoftShellHelper extends Extension {
    enable() {
        this._loftWmClasses = new Set(LOFT_WM_CLASS_LIST);
        this._panelIcons = new Map();
        this._combinedIndicator = null;
        this._combinedServices = new Map();
        this._combinedWatchId = null;
        this._pendingDashTimeouts = new Set();

        // D-Bus interface — window focus/hide + panel icon management.
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE);
        this._dbusId = Gio.DBus.session.register_object(
            DBUS_PATH,
            nodeInfo.interfaces[0],
            (connection, sender, path, iface, method, params, invocation) => {
                this._onMethodCall(method, params, invocation);
            },
            null,
            null
        );

        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null, null, null
        );

        // Hide minimized Loft windows from alt-tab, overview, and dock.
        const wmClasses = this._loftWmClasses;

        // Alt-tab: drop minimized Loft windows from the switcher, and drop
        // apps that have nothing else to show. Also correct the default
        // selection when the currently focused window is a Loft service —
        // Mutter's focus-app property still points at com.google.Chrome
        // (which we've hidden from the running list), so the switcher
        // defaults to index 0, which happens to be the Loft app itself.
        AppSwitcherPopup.prototype._init = function() {
            _origAppSwitcherInit.call(this);
            for (const item of [...this._items]) {
                const before = item.cachedWindows.length;
                item.cachedWindows = item.cachedWindows.filter(
                    w => !_isMinimizedLoftWindow(w, wmClasses)
                );
                if (before > 0 && item.cachedWindows.length === 0)
                    this._switcherList._removeIcon(item.app);
            }
        };

        // Default selection: the base class picks index 1 ("next most recent
        // app"), which relies on the MRU sort putting the currently focused
        // app at index 0. For Loft windows, Mutter's internal focus mapping
        // still points at com.google.Chrome (not in the running list), so
        // that sort can put the Loft service anywhere — and the default
        // selection lands on the focused Loft app itself. Rewrite the
        // selection explicitly: current focused app + 1, wrap around.
        AppSwitcherPopup.prototype._initialSelection = function(backward, binding) {
            const focus = global.display.get_focus_window?.();
            const focusWc = focus?.get_wm_class?.() ?? '';
            if (focusWc && wmClasses.has(focusWc) && this._items.length > 1) {
                const targetId = `${focusWc}.desktop`;
                const currentIdx = this._items.findIndex(
                    i => i.app?.get_id?.() === targetId
                );
                if (currentIdx >= 0) {
                    if (backward || binding === 'switch-applications-backward')
                        return (currentIdx - 1 + this._items.length) % this._items.length;
                    return (currentIdx + 1) % this._items.length;
                }
            }
            return _origAppSwitcherInitialSelection.call(this, backward, binding);
        };

        // Activities overview: same treatment.
        Workspace.prototype._isOverviewWindow = function(win) {
            const show = _origIsOverviewWindow.call(this, win);
            if (!show)
                return false;
            if (!_isLoftWindow(win, wmClasses))
                return true;
            let meta = win;
            if (win.get_meta_window)
                meta = win.get_meta_window();
            return !meta.minimized;
        };

        // Dock: show one icon per Loft service instead of a single Chrome
        // icon. Flatpak Chrome on Wayland reports app_id=com.google.Chrome
        // for every PWA, so Mutter groups every Loft window under Chrome's
        // .desktop. Swap Chrome out for the per-service apps whenever Chrome
        // has no non-Loft windows.
        const appSystem_running = Shell.AppSystem.get_default();
        const CHROME_APP_IDS = new Set([
            'com.google.Chrome.desktop',
            'google-chrome.desktop',
        ]);
        Shell.AppSystem.prototype.get_running = function() {
            const apps = _origGetRunning.call(this);

            const loftWinsByClass = new Map();
            for (const actor of global.get_window_actors()) {
                const w = actor.meta_window;
                if (w.get_window_type?.() !== Meta.WindowType.NORMAL)
                    continue;
                const wc = w.get_wm_class?.() ?? '';
                if (!wmClasses.has(wc))
                    continue;
                if (!loftWinsByClass.has(wc))
                    loftWinsByClass.set(wc, []);
                loftWinsByClass.get(wc).push(w);
            }

            const result = [];
            const seenIds = new Set();
            for (const app of apps) {
                const id = app.get_id?.() ?? '';
                const windows = app.get_windows();

                if (CHROME_APP_IDS.has(id)) {
                    const nonLoft = windows.filter(
                        w => !wmClasses.has(w.get_wm_class?.() ?? '')
                    );
                    if (nonLoft.length === 0)
                        continue;
                }

                // Don't show Loft apps while they're hidden to tray.
                if (windows.length > 0 &&
                    windows.every(w => _isMinimizedLoftWindow(w, wmClasses))) {
                    continue;
                }

                seenIds.add(id);
                result.push(app);
            }

            for (const [wc, wins] of loftWinsByClass) {
                if (wins.every(w => w.minimized))
                    continue;
                const svcApp = appSystem_running.lookup_app(`${wc}.desktop`);
                if (!svcApp)
                    continue;
                const svcId = svcApp.get_id();
                if (seenIds.has(svcId))
                    continue;
                seenIds.add(svcId);
                result.push(svcApp);
            }

            return result;
        };

        // Make each service's app report its own windows (and Chrome stop
        // claiming them). Alt-tab and dock clicks raise windows via
        // app.get_windows()[0], which is empty on the Loft apps until we
        // route the Chrome windows over.
        Shell.App.prototype.get_windows = function() {
            const id = this.get_id?.() ?? '';
            if (CHROME_APP_IDS.has(id)) {
                return _origAppGetWindows.call(this).filter(
                    w => !wmClasses.has(w.get_wm_class?.() ?? '')
                );
            }
            const maybeWmClass = id.replace(/\.desktop$/, '');
            if (wmClasses.has(maybeWmClass)) {
                const out = [];
                for (const actor of global.get_window_actors()) {
                    const w = actor.meta_window;
                    if (w.get_window_type?.() !== Meta.WindowType.NORMAL)
                        continue;
                    if (w.get_wm_class?.() === maybeWmClass)
                        out.push(w);
                }
                return out;
            }
            return _origAppGetWindows.call(this);
        };

        // Route Loft windows to their own app instead of com.google.Chrome.
        const appSystem = Shell.AppSystem.get_default();
        Shell.WindowTracker.prototype.get_window_app = function(metaWindow) {
            const wmClass = metaWindow?.get_wm_class?.() ?? '';
            if (wmClasses.has(wmClass)) {
                const app = appSystem.lookup_app(`${wmClass}.desktop`);
                if (app)
                    return app;
            }
            return _origGetWindowApp.call(this, metaWindow);
        };

        // Focus-tracking uses this to decide "what app is in front" — alt-tab
        // needs it to pick the next entry correctly.
        Shell.WindowTracker.prototype.get_focus_app = function() {
            const focus = global.display.get_focus_window?.();
            const wc = focus?.get_wm_class?.() ?? '';
            if (wc && wmClasses.has(wc)) {
                const app = appSystem.lookup_app(`${wc}.desktop`);
                if (app)
                    return app;
            }
            return _origGetFocusApp.call(this);
        };

        // Shell.App.activate_window() / activate() live in C and consult
        // the C-side window list to pick the window to raise. That list
        // still maps everything to com.google.Chrome, so alt-tab / dash
        // clicks silently no-op for Loft apps. Intercept here and raise
        // the window directly.
        const _loftActivateWindow = (w, time) => {
            if (!w) return;
            const currentWs = global.workspace_manager.get_active_workspace();
            if (w.get_workspace() !== currentWs)
                w.change_workspace(currentWs);
            if (w.minimized)
                w.unminimize();
            w.activate(time ?? global.get_current_time());
        };

        Shell.App.prototype.activate_window = function(window, timestamp) {
            const id = this.get_id?.() ?? '';
            const maybeWmClass = id.replace(/\.desktop$/, '');
            if (wmClasses.has(maybeWmClass)) {
                _loftActivateWindow(window, timestamp);
                return;
            }
            return _origAppActivateWindow.call(this, window, timestamp);
        };

        Shell.App.prototype.activate = function() {
            const id = this.get_id?.() ?? '';
            const maybeWmClass = id.replace(/\.desktop$/, '');
            if (wmClasses.has(maybeWmClass)) {
                const windows = this.get_windows();
                if (windows.length > 0) {
                    _loftActivateWindow(windows[0]);
                    return;
                }
            }
            return _origAppActivate.call(this);
        };

        // A minimize/unminimize doesn't change app running state, so the
        // dash won't rebuild on its own — nudge it.
        global.window_manager.connectObject(
            'minimize', (wm, actor) => this._notifyDashIfLoft(actor.meta_window),
            'unminimize', (wm, actor) => this._notifyDashIfLoft(actor.meta_window),
            this
        );
    }

    disable() {
        for (const id of this._pendingDashTimeouts)
            GLib.Source.remove(id);
        this._pendingDashTimeouts = null;

        this._unregisterCombined();
        this._combinedServices = null;

        for (const name of [...this._panelIcons.keys()])
            this._unregisterService(name);
        this._panelIcons = null;

        Workspace.prototype._isOverviewWindow = _origIsOverviewWindow;
        AppSwitcherPopup.prototype._init = _origAppSwitcherInit;
        AppSwitcherPopup.prototype._initialSelection = _origAppSwitcherInitialSelection;
        Shell.AppSystem.prototype.get_running = _origGetRunning;
        Shell.WindowTracker.prototype.get_window_app = _origGetWindowApp;
        Shell.WindowTracker.prototype.get_focus_app = _origGetFocusApp;
        Shell.App.prototype.get_windows = _origAppGetWindows;
        Shell.App.prototype.activate = _origAppActivate;
        Shell.App.prototype.activate_window = _origAppActivateWindow;

        global.window_manager.disconnectObject(this);

        if (this._dbusId) {
            Gio.DBus.session.unregister_object(this._dbusId);
            this._dbusId = null;
        }
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = null;
        }

        this._loftWmClasses = null;
    }

    _registerService(name, displayName, iconName, wmClass) {
        if (this._panelIcons.has(name)) {
            this._panelIcons.get(name).indicator?.destroy();
            this._panelIcons.delete(name);
        }

        const indicator = new PanelMenu.Button(0.0, `loft-${name}`, false);

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: false,
            y_expand: true,
            style_class: 'panel-status-indicators-box',
        });
        indicator.add_child(box);

        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(icon);

        // Unread dot and DND dash overlay the icon's bottom-right corner.
        // BinLayout alignment is unreliable for overlays — position them
        // manually from the icon's allocation instead.
        const DOT_SIZE = 6;
        const badge = new St.Widget({
            style: `background-color: #e01b24; border-radius: ${DOT_SIZE / 2}px; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`,
            visible: false,
        });
        box.add_child(badge);

        const DASH_W = 8;
        const DASH_H = 2;
        const dndBadge = new St.Widget({
            style: `background-color: #888888; border-radius: ${DASH_H / 2}px; width: ${DASH_W}px; height: ${DASH_H}px;`,
            visible: false,
        });
        box.add_child(dndBadge);

        icon.connect('notify::allocation', () => {
            badge.set_position(
                icon.x + icon.width - DOT_SIZE,
                icon.y + icon.height - DOT_SIZE
            );
            dndBadge.set_position(
                icon.x + icon.width - DASH_W,
                icon.y + icon.height - DASH_H
            );
        });

        const dbusServiceName = this._dbusNameForService(name);

        const showHideItem = new PopupMenu.PopupMenuItem('Show');
        showHideItem.connect('activate', () => {
            this._callDaemonMethod(dbusServiceName, 'Toggle');
        });
        indicator.menu.addMenuItem(showHideItem);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const dndItem = new PopupMenu.PopupSwitchMenuItem('Do Not Disturb', false);
        dndItem.connect('toggled', (_item, state) => {
            this._callDaemonMethod(dbusServiceName, 'SetDnd', '(b)', [state]);
        });
        indicator.menu.addMenuItem(dndItem);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const quitItem = new PopupMenu.PopupMenuItem('Quit');
        quitItem.connect('activate', () => {
            this._callDaemonMethod(dbusServiceName, 'Quit');
        });
        indicator.menu.addMenuItem(quitItem);

        Main.panel.addToStatusArea(`loft-${name}`, indicator);

        // If the daemon vanishes, drop our panel icon with it.
        // name_vanished fires immediately when the name doesn't exist yet,
        // so only react once we've seen it appear.
        const daemonBusName = `chat.loft.${dbusServiceName}`;
        let nameAppeared = false;
        const watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            daemonBusName,
            Gio.BusNameWatcherFlags.NONE,
            () => { nameAppeared = true; },
            () => {
                if (nameAppeared)
                    this._unregisterService(name);
            }
        );

        this._panelIcons.set(name, {
            indicator,
            icon,
            badge,
            dndBadge,
            dndItem,
            showHideItem,
            wmClass,
            dbusServiceName,
            watchId,
            badgeCount: 0,
            dndEnabled: false,
        });
    }

    _unregisterService(name) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        if (entry.watchId)
            Gio.bus_unwatch_name(entry.watchId);
        entry.indicator?.destroy();
        this._panelIcons.delete(name);
    }

    _updateBadge(name, count) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        entry.badgeCount = count;
        entry.badge.visible = count > 0 && !entry.dndEnabled;
    }

    _updateDnd(name, enabled) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        entry.dndEnabled = enabled;
        entry.dndItem.setToggleState(enabled);
        entry.dndBadge.visible = enabled;
        entry.badge.visible = entry.badgeCount > 0 && !enabled;
    }

    _updateVisible(name, visible) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        entry.showHideItem.label.text = visible ? 'Hide' : 'Show';
    }

    _dbusNameForService(name) {
        const map = {
            'whatsapp': 'WhatsApp',
            'messenger': 'Messenger',
            'slack': 'Slack',
            'telegram': 'Telegram',
        };
        return map[name] || name;
    }

    _callDaemonMethod(dbusName, method, signature, args) {
        const busName = `chat.loft.${dbusName}`;
        const objPath = `/chat/loft/${dbusName}`;
        const iface = 'chat.loft.Service';

        try {
            const params = signature
                ? new GLib.Variant(signature, args)
                : null;

            Gio.DBus.session.call(
                busName, objPath, iface, method,
                params,
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,
                null,
                null
            );
        } catch (e) {
            console.error(`Loft: Failed to call ${busName}.${method}: ${e}`);
        }
    }

    _registerCombined(iconName) {
        if (this._combinedIndicator) {
            this._combinedIndicator.destroy();
            this._combinedIndicator = null;
        }
        if (this._combinedWatchId) {
            Gio.bus_unwatch_name(this._combinedWatchId);
            this._combinedWatchId = null;
        }
        this._combinedServices.clear();

        const indicator = new PanelMenu.Button(0.0, 'loft-combined', false);

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: false,
            y_expand: true,
            style_class: 'panel-status-indicators-box',
        });
        indicator.add_child(box);

        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(icon);

        const DOT_SIZE = 6;
        const badge = new St.Widget({
            style: `background-color: #e01b24; border-radius: ${DOT_SIZE / 2}px; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`,
            visible: false,
        });
        box.add_child(badge);

        const DASH_W = 8;
        const DASH_H = 2;
        const dndBadge = new St.Widget({
            style: `background-color: #888888; border-radius: ${DASH_H / 2}px; width: ${DASH_W}px; height: ${DASH_H}px;`,
            visible: false,
        });
        box.add_child(dndBadge);

        icon.connect('notify::allocation', () => {
            badge.set_position(
                icon.x + icon.width - DOT_SIZE,
                icon.y + icon.height - DOT_SIZE
            );
            dndBadge.set_position(
                icon.x + icon.width - DASH_W,
                icon.y + icon.height - DASH_H
            );
        });

        Main.panel.addToStatusArea('loft-combined', indicator);

        this._combinedIndicator = indicator;
        this._combinedIcon = icon;
        this._combinedBadge = badge;
        this._combinedDndBadge = dndBadge;

        // Drop the combined icon if the tray process exits.
        let nameAppeared = false;
        this._combinedWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'chat.loft.Tray',
            Gio.BusNameWatcherFlags.NONE,
            () => { nameAppeared = true; },
            () => {
                if (nameAppeared)
                    this._unregisterCombined();
            }
        );

        this._rebuildCombinedMenu();
    }

    _unregisterCombined() {
        if (this._combinedWatchId) {
            Gio.bus_unwatch_name(this._combinedWatchId);
            this._combinedWatchId = null;
        }
        this._combinedIndicator?.destroy();
        this._combinedIndicator = null;
        this._combinedIcon = null;
        this._combinedBadge = null;
        this._combinedDndBadge = null;
        this._combinedServices?.clear();
    }

    _updateCombinedService(name, displayName, visible, badge, dnd, wmClass) {
        const existing = this._combinedServices.get(name);
        if (existing &&
            existing.displayName === displayName &&
            existing.visible === visible &&
            existing.badge === badge &&
            existing.dnd === dnd &&
            existing.wmClass === wmClass) {
            return;
        }
        this._combinedServices.set(name, { displayName, visible, badge, dnd, wmClass });
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _removeCombinedService(name) {
        this._combinedServices.delete(name);
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _rebuildCombinedMenu() {
        if (!this._combinedIndicator) return;

        const menu = this._combinedIndicator.menu;
        menu.removeAll();

        const settingsItem = new PopupMenu.PopupMenuItem('Loft Settings\u2026');
        settingsItem.connect('activate', () => {
            const appInfo = Gio.DesktopAppInfo.new('chat.loft.Loft.desktop')
                ?? Gio.DesktopAppInfo.new('chat.loft.Manager.desktop');
            if (appInfo) {
                try {
                    appInfo.launch([], null);
                } catch (e) {
                    console.error(`Loft: Failed to launch manager: ${e}`);
                }
            } else {
                console.error('Loft: No .desktop file found for manager');
            }
        });
        menu.addMenuItem(settingsItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // One compact row per service: name + unread dot + [Show/Hide] [DND] [Quit]
        for (const [name, svc] of this._combinedServices) {
            const dbusName = this._dbusNameForService(name);

            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });

            const row = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(row);

            // Service name
            const label = new St.Label({
                text: svc.displayName,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            row.add_child(label);

            // Unread dot
            if (svc.badge > 0 && !svc.dnd) {
                const dot = new St.Label({
                    text: ' \u2022',
                    style: 'color: #e01b24; font-size: 16px;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(dot);
            }

            // Show/Hide icon button
            const showHideIconName = svc.visible ? 'hide-window-symbolic' : 'show-window-symbolic';
            const showHideIconFile = Gio.File.new_for_path(
                GLib.build_filenamev([this.path, 'icons', `${showHideIconName}.svg`])
            );
            const showHideBtn = new St.Button({
                child: new St.Icon({ gicon: new Gio.FileIcon({ file: showHideIconFile }), icon_size: 16 }),
                style_class: 'button',
                style: 'margin-left: 12px; padding: 2px 6px;',
                can_focus: true,
            });
            showHideBtn.connect('clicked', () => {
                this._callDaemonMethod(dbusName, 'Toggle');
                menu.close();
            });
            row.add_child(showHideBtn);

            // DND icon toggle
            const dndIcon = svc.dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic';
            const dndBtn = new St.Button({
                child: new St.Icon({ icon_name: dndIcon, icon_size: 16 }),
                style_class: 'button',
                style: `margin-left: 4px; padding: 2px 6px;${svc.dnd ? ' opacity: 128;' : ''}`,
                can_focus: true,
            });
            dndBtn.connect('clicked', () => {
                this._callDaemonMethod(dbusName, 'SetDnd', '(b)', [!svc.dnd]);
            });
            row.add_child(dndBtn);

            // Quit icon button
            const quitBtn = new St.Button({
                child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
                style_class: 'button',
                style: 'margin-left: 4px; padding: 2px 6px;',
                can_focus: true,
            });
            quitBtn.connect('clicked', () => {
                this._callDaemonMethod(dbusName, 'Quit');
                menu.close();
            });
            row.add_child(quitBtn);

            menu.addMenuItem(item);
        }

        if (this._combinedServices.size === 0) {
            const noServices = new PopupMenu.PopupMenuItem('No services running', { reactive: false });
            menu.addMenuItem(noServices);
        }
    }

    _updateCombinedBadges() {
        if (!this._combinedIndicator) return;

        let anyBadge = false;
        let allDnd = this._combinedServices.size > 0;

        for (const [, svc] of this._combinedServices) {
            if (svc.badge > 0 && !svc.dnd)
                anyBadge = true;
            if (!svc.dnd)
                allDnd = false;
        }

        this._combinedBadge.visible = anyBadge && !allDnd;
        this._combinedDndBadge.visible = allDnd;
    }

    _notifyDashIfLoft(win) {
        const wmClass = win.get_wm_class?.() ?? '';
        if (!this._loftWmClasses.has(wmClass))
            return;
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app)
            return;
        // Let the minimize animation settle before poking the dash.
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._pendingDashTimeouts?.delete(id);
            Shell.AppSystem.get_default().emit('app-state-changed', app);
            return GLib.SOURCE_REMOVE;
        });
        this._pendingDashTimeouts?.add(id);
    }

    _findWindow(wmClass) {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.get_wm_class() === wmClass &&
                win.get_window_type() === Meta.WindowType.NORMAL)
                return win;
        }
        return null;
    }

    _onMethodCall(method, params, invocation) {
        if (method === 'FocusWindow' || method === 'HideWindow') {
            const [wmClass] = params.deep_unpack();

            if (method === 'FocusWindow') {
                const win = this._findWindow(wmClass);
                if (win) {
                    if (win.minimized)
                        win.unminimize();
                    // Move the window to the current workspace first, so
                    // activate() doesn't trip focus-stealing-prevention and
                    // bounce the user to the window's old workspace.
                    const currentWs = global.workspace_manager.get_active_workspace();
                    if (win.get_workspace() !== currentWs)
                        win.change_workspace(currentWs);
                    win.activate(global.get_current_time());
                    invocation.return_value(GLib.Variant.new('(b)', [true]));
                } else {
                    invocation.return_value(GLib.Variant.new('(b)', [false]));
                }
            } else {
                const win = this._findWindow(wmClass);
                if (win) {
                    win.minimize();
                    invocation.return_value(GLib.Variant.new('(b)', [true]));
                } else {
                    invocation.return_value(GLib.Variant.new('(b)', [false]));
                }
            }
            return;
        }

        if (method === 'RegisterService') {
            const [name, displayName, iconName, wmClass] = params.deep_unpack();
            this._registerService(name, displayName, iconName, wmClass);
            invocation.return_value(null);
            return;
        }

        if (method === 'UnregisterService') {
            const [name] = params.deep_unpack();
            this._unregisterService(name);
            invocation.return_value(null);
            return;
        }

        if (method === 'UpdateBadge') {
            const [name, count] = params.deep_unpack();
            this._updateBadge(name, count);
            invocation.return_value(null);
            return;
        }

        if (method === 'UpdateDnd') {
            const [name, enabled] = params.deep_unpack();
            this._updateDnd(name, enabled);
            invocation.return_value(null);
            return;
        }

        if (method === 'UpdateVisible') {
            const [name, visible] = params.deep_unpack();
            this._updateVisible(name, visible);
            invocation.return_value(null);
            return;
        }

        // Combined icon methods
        if (method === 'RegisterCombined') {
            const [iconName] = params.deep_unpack();
            this._registerCombined(iconName);
            invocation.return_value(null);
            return;
        }

        if (method === 'UnregisterCombined') {
            this._unregisterCombined();
            invocation.return_value(null);
            return;
        }

        if (method === 'UpdateCombinedService') {
            const [name, displayName, visible, badge, dnd, wmClass] = params.deep_unpack();
            this._updateCombinedService(name, displayName, visible, badge, dnd, wmClass);
            invocation.return_value(null);
            return;
        }

        if (method === 'RemoveCombinedService') {
            const [name] = params.deep_unpack();
            this._removeCombinedService(name);
            invocation.return_value(null);
            return;
        }

        invocation.return_dbus_error(
            'org.freedesktop.DBus.Error.UnknownMethod',
            `Unknown method: ${method}`
        );
    }
}
