// SPDX-License-Identifier: GPL-3.0-or-later
// Loft Shell Helper — window management and panel icons for Loft services.
//
// 1. Exposes a D-Bus interface so the Loft daemon can focus/hide Chrome
//    windows without triggering GNOME's focus-stealing prevention.
// 2. Hides minimized Loft windows from alt-tab, overview, and the dock.
// 3. Provides native GNOME panel icons as an alternative to SNI tray icons.

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

// WM_CLASS values for Loft-managed Chrome app windows.
// Chrome in --app= mode sets WM_CLASS to "chrome-<sanitised_url>-<profile>".
const LOFT_WM_CLASSES = new Set([
    'chrome-web.whatsapp.com__-Default',
    'chrome-facebook.com__messages_-Default',
]);

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

// Save original prototypes for clean restore on disable
const _origIsOverviewWindow = Workspace.prototype._isOverviewWindow;
const _origAppSwitcherInit = AppSwitcherPopup.prototype._init;
const _origGetRunning = Shell.AppSystem.prototype.get_running;

function _isLoftWindow(win) {
    let meta = win;
    if (win.get_meta_window)
        meta = win.get_meta_window();
    const wmClass = meta.get_wm_class?.() ?? '';
    return LOFT_WM_CLASSES.has(wmClass);
}

function _isMinimizedLoftWindow(win) {
    const wmClass = win.get_wm_class?.() ?? '';
    return LOFT_WM_CLASSES.has(wmClass) && win.minimized;
}

export default class LoftShellHelper extends Extension {
    enable() {
        // Panel icon registry: service name → { indicator, badge, dndItem, showHideItem, wmClass }
        this._panelIcons = new Map();
        // Combined icon state
        this._combinedIndicator = null;
        this._combinedServices = new Map(); // name → { displayName, visible, badge, dnd, wmClass }
        this._combinedWatchId = null;

        // --- D-Bus interface for window focus/hide + panel icons ---

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

        // --- Hide minimized Loft windows from alt-tab, overview, and dock ---

        // Alt-Tab: AppSwitcherPopup._init builds the app/window list.
        // After the original _init runs, filter out minimized Loft windows
        // from each app's cachedWindows, and remove apps with no remaining windows.
        AppSwitcherPopup.prototype._init = function() {
            _origAppSwitcherInit.call(this);

            // Filter minimized Loft windows from each app entry
            for (const item of [...this._items]) {
                const before = item.cachedWindows.length;
                item.cachedWindows = item.cachedWindows.filter(
                    w => !_isMinimizedLoftWindow(w)
                );
                // If all windows were filtered out, remove this app entry
                if (before > 0 && item.cachedWindows.length === 0)
                    this._switcherList._removeIcon(item.app);
            }
        };

        // Overview: Patch _isOverviewWindow to exclude minimized Loft windows
        Workspace.prototype._isOverviewWindow = function(win) {
            const show = _origIsOverviewWindow.call(this, win);
            if (!show)
                return false;
            if (!_isLoftWindow(win))
                return true;
            let meta = win;
            if (win.get_meta_window)
                meta = win.get_meta_window();
            return !meta.minimized;
        };

        // Dock: Patch get_running() so the dash doesn't show Loft apps
        // whose windows are all minimized (hidden to tray).
        Shell.AppSystem.prototype.get_running = function() {
            const apps = _origGetRunning.call(this);
            return apps.filter(app => {
                const windows = app.get_windows();
                if (windows.length === 0)
                    return true;
                return !windows.every(w => _isMinimizedLoftWindow(w));
            });
        };

        // Trigger a dock rebuild when a Loft window is minimized/unminimized,
        // since the app's running state doesn't actually change.
        this._minimizeId = global.window_manager.connect('minimize',
            (wm, actor) => this._notifyDashIfLoft(actor.meta_window));
        this._unminimizeId = global.window_manager.connect('unminimize',
            (wm, actor) => this._notifyDashIfLoft(actor.meta_window));
    }

    disable() {
        // Destroy combined icon if present
        if (this._combinedWatchId)
            Gio.bus_unwatch_name(this._combinedWatchId);
        this._combinedIndicator?.destroy();
        this._combinedIndicator = null;
        this._combinedServices?.clear();
        this._combinedWatchId = null;

        // Destroy all panel icons and stop name watches
        for (const [name, entry] of this._panelIcons) {
            if (entry.watchId)
                Gio.bus_unwatch_name(entry.watchId);
            entry.indicator?.destroy();
        }
        this._panelIcons.clear();

        // Restore original prototypes
        Workspace.prototype._isOverviewWindow = _origIsOverviewWindow;
        AppSwitcherPopup.prototype._init = _origAppSwitcherInit;
        Shell.AppSystem.prototype.get_running = _origGetRunning;

        // Disconnect minimize/unminimize handlers
        if (this._minimizeId) {
            global.window_manager.disconnect(this._minimizeId);
            this._minimizeId = null;
        }
        if (this._unminimizeId) {
            global.window_manager.disconnect(this._unminimizeId);
            this._unminimizeId = null;
        }

        // Release D-Bus
        if (this._dbusId) {
            Gio.DBus.session.unregister_object(this._dbusId);
            this._dbusId = null;
        }
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = null;
        }
    }

    // ================================================================
    // Panel icon management
    // ================================================================

    _registerService(name, displayName, iconName, wmClass) {
        // Remove existing indicator for this service if any
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

        // Small red dot at bottom-right of the icon.
        // BinLayout alignment is unreliable for overlay positioning, so we
        // track the icon's actual allocation and set the dot position explicitly.
        const DOT_SIZE = 6;
        const badge = new St.Widget({
            style: `background-color: #e01b24; border-radius: ${DOT_SIZE / 2}px; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`,
            visible: false,
        });
        box.add_child(badge);

        // Small grey dash at bottom-right for DND indicator (replaces badge dot).
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

        // --- Popup menu ---

        // Derive D-Bus name from the service name for calling daemon methods.
        // Service D-Bus names: "WhatsApp", "Messenger" — capitalize first letter,
        // but these are passed via wmClass mapping. Use a lookup instead.
        const dbusServiceName = this._dbusNameForService(name);

        // Show / Hide toggle
        const showHideItem = new PopupMenu.PopupMenuItem('Show');
        showHideItem.connect('activate', () => {
            this._callDaemonMethod(dbusServiceName, 'Toggle');
        });
        indicator.menu.addMenuItem(showHideItem);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Do Not Disturb toggle
        const dndItem = new PopupMenu.PopupSwitchMenuItem('Do Not Disturb', false);
        dndItem.connect('toggled', (_item, state) => {
            this._callDaemonMethod(dbusServiceName, 'SetDnd', '(b)', [state]);
        });
        indicator.menu.addMenuItem(dndItem);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quit
        const quitItem = new PopupMenu.PopupMenuItem('Quit');
        quitItem.connect('activate', () => {
            this._callDaemonMethod(dbusServiceName, 'Quit');
        });
        indicator.menu.addMenuItem(quitItem);

        Main.panel.addToStatusArea(`loft-${name}`, indicator);

        // Watch the daemon's D-Bus name — remove panel icon if daemon exits.
        // name_vanished fires immediately if the name isn't on the bus yet,
        // so track whether we've seen it appear first.
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
        // DND suppresses the badge — the dash replaces it
        entry.badge.visible = count > 0 && !entry.dndEnabled;
    }

    _updateDnd(name, enabled) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        entry.dndEnabled = enabled;
        entry.dndItem.setToggleState(enabled);
        entry.dndBadge.visible = enabled;
        // Hide badge when DND is on, restore when off
        entry.badge.visible = entry.badgeCount > 0 && !enabled;
    }

    _updateVisible(name, visible) {
        const entry = this._panelIcons.get(name);
        if (!entry) return;
        entry.showHideItem.label.text = visible ? 'Hide' : 'Show';
    }

    // Map service name → D-Bus name (e.g. "whatsapp" → "WhatsApp")
    _dbusNameForService(name) {
        const map = {
            'whatsapp': 'WhatsApp',
            'messenger': 'Messenger',
        };
        return map[name] || name;
    }

    // Fire-and-forget D-Bus call to the per-service daemon
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
                null,       // reply type
                Gio.DBusCallFlags.NO_AUTO_START,
                -1,         // timeout (default)
                null,       // cancellable
                null        // callback (fire-and-forget)
            );
        } catch (e) {
            log(`Loft: Failed to call ${busName}.${method}: ${e}`);
        }
    }

    // ================================================================
    // Combined panel icon management
    // ================================================================

    _registerCombined(iconName) {
        // Remove existing combined indicator if any
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

        // Badge dot
        const DOT_SIZE = 6;
        const badge = new St.Widget({
            style: `background-color: #e01b24; border-radius: ${DOT_SIZE / 2}px; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;`,
            visible: false,
        });
        box.add_child(badge);

        // DND dash
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
        this._combinedBadge = badge;
        this._combinedDndBadge = dndBadge;

        // Watch the combined tray D-Bus name — destroy if it exits
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

        // Build the menu (initially empty)
        this._rebuildCombinedMenu();
    }

    _unregisterCombined() {
        if (this._combinedWatchId) {
            Gio.bus_unwatch_name(this._combinedWatchId);
            this._combinedWatchId = null;
        }
        this._combinedIndicator?.destroy();
        this._combinedIndicator = null;
        this._combinedServices.clear();
    }

    _updateCombinedService(name, displayName, visible, badge, dnd, wmClass) {
        const existing = this._combinedServices.get(name);
        if (existing &&
            existing.displayName === displayName &&
            existing.visible === visible &&
            existing.badge === badge &&
            existing.dnd === dnd &&
            existing.wmClass === wmClass) {
            return; // No change, skip menu rebuild
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

        let first = true;
        for (const [name, svc] of this._combinedServices) {
            if (!first)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            first = false;

            const dbusName = this._dbusNameForService(name);

            // Service header with unread indicator
            const hasUnread = svc.badge > 0 && !svc.dnd;
            const header = new PopupMenu.PopupMenuItem(svc.displayName, { reactive: false });
            header.label.add_style_class_name('popup-menu-item-title');
            if (hasUnread) {
                const dot = new St.Label({ text: ' \u2022', style: 'color: #e01b24;' });
                header.add_child(dot);
            }
            menu.addMenuItem(header);

            // Show / Hide
            const showHideItem = new PopupMenu.PopupMenuItem(svc.visible ? 'Hide' : 'Show');
            showHideItem.connect('activate', () => {
                this._callDaemonMethod(dbusName, 'Toggle');
            });
            menu.addMenuItem(showHideItem);

            // DND toggle
            const dndItem = new PopupMenu.PopupSwitchMenuItem('Do Not Disturb', svc.dnd);
            dndItem.connect('toggled', (_item, state) => {
                this._callDaemonMethod(dbusName, 'SetDnd', '(b)', [state]);
            });
            menu.addMenuItem(dndItem);

            // Quit
            const quitItem = new PopupMenu.PopupMenuItem('Quit');
            quitItem.connect('activate', () => {
                this._callDaemonMethod(dbusName, 'Quit');
            });
            menu.addMenuItem(quitItem);
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

    // ================================================================
    // Window management helpers
    // ================================================================

    _notifyDashIfLoft(win) {
        const wmClass = win.get_wm_class?.() ?? '';
        if (!LOFT_WM_CLASSES.has(wmClass))
            return;
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app)
            return;
        // Short delay to let the minimize/unminimize animation settle,
        // then poke the app-state-changed signal so the dash rebuilds.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            Shell.AppSystem.get_default().emit('app-state-changed', app);
            return GLib.SOURCE_REMOVE;
        });
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
        // Window management methods (take a single string: wm_class)
        if (method === 'FocusWindow' || method === 'HideWindow') {
            const [wmClass] = params.deep_unpack();

            if (method === 'FocusWindow') {
                const win = this._findWindow(wmClass);
                if (win) {
                    if (win.minimized)
                        win.unminimize();
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

        // Panel icon methods
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
