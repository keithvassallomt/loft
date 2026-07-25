// SPDX-License-Identifier: GPL-3.0-or-later
// Loft Shell Helper — panel indicator and window management for the Loft app.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AppSwitcherPopup} from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DBUS_NAME = 'chat.loft.ShellHelper';
const DBUS_PATH = '/chat/loft/ShellHelper';

// UpdateCombinedService's trailing `key` repeats `display_name`; Loft sends the
// same string for both. It is kept in the signature because Loft and this
// extension update independently — GDBus rejects a call whose signature does
// not match the registered interface, so dropping the argument would break
// every existing Loft install until it too was updated.
const DBUS_IFACE = `<node>
  <interface name="${DBUS_NAME}">
    <method name="FocusWindow">
      <arg name="key" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="HideWindow">
      <arg name="key" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="SetLoftWindows">
      <arg name="keys" type="as" direction="in"/>
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
      <arg name="key" type="s" direction="in"/>
    </method>
    <method name="RemoveCombinedService">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="UpdateAvailableService">
      <arg name="name" type="s" direction="in"/>
      <arg name="display_name" type="s" direction="in"/>
    </method>
    <method name="RemoveAvailableService">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="UpdateGlobalDnd">
      <arg name="enabled" type="b" direction="in"/>
    </method>
  </interface>
</node>`;

const BADGE_SIZE = 6;
const DND_DASH_WIDTH = 8;
const DND_DASH_HEIGHT = 2;

const UNREAD_COLOR = '#e01b24';
const DND_COLOR = '#888888';

// Every Loft window shares one WM_CLASS, so the title is the only thing that
// tells them apart: a window is Loft's iff its title is one of the keys Loft
// pushed, or that key plus a parenthesised unread count ("WhatsApp (3)").
function titleMatchesKey(title, key) {
    return title === key || title.startsWith(`${key} (`);
}

function isLoftTitleWindow(win, titleKeys) {
    const title = win.get_title() ?? '';
    for (const key of titleKeys) {
        if (titleMatchesKey(title, key))
            return true;
    }
    return false;
}

function isMinimizedLoftWindow(win, titleKeys) {
    return win.minimized && isLoftTitleWindow(win, titleKeys);
}

export default class LoftShellHelper extends Extension {
    enable() {
        // Titles of the windows Loft owns, replaced wholesale by SetLoftWindows.
        // The alt-tab override captures this Set, so it is mutated in place and
        // never reassigned.
        this._loftTitleKeys = new Set();

        this._combinedIndicator = null;
        this._combinedIcon = null;
        this._combinedBadge = null;
        this._combinedDndBadge = null;
        this._combinedWatchId = null;
        this._combinedServices = new Map();
        // Configured-but-not-running services, rendered as launch rows below the
        // running ones.
        this._combinedAvailable = new Map();
        // Pushed via UpdateGlobalDnd. Mirrors the SNI menu's "Do Not Disturb":
        // it mutes every service at once.
        this._combinedGlobalDnd = false;

        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE);
        this._dbusId = Gio.DBus.session.register_object(
            DBUS_PATH,
            nodeInfo.interfaces[0],
            (connection, sender, path, iface, method, params, invocation) => {
                this._onMethodCall(method, params, invocation);
            },
            null,
            null);

        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null, null, null);

        // Drop windows Loft has hidden to the tray from alt-tab, along with any
        // app left with nothing to show.
        const titleKeys = this._loftTitleKeys;
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(
            AppSwitcherPopup.prototype, '_init',
            originalMethod => /** @this {AppSwitcherPopup} */ function (...args) {
                originalMethod.call(this, ...args);
                for (const item of [...this._items]) {
                    const before = item.cachedWindows.length;
                    item.cachedWindows = item.cachedWindows.filter(
                        w => !isMinimizedLoftWindow(w, titleKeys));
                    if (before > 0 && item.cachedWindows.length === 0)
                        this._switcherList._removeIcon(item.app);
                }
            });
    }

    disable() {
        this._injectionManager.clear();
        this._injectionManager = null;

        this._unregisterCombined();
        this._combinedServices = null;
        this._combinedAvailable = null;

        Gio.DBus.session.unregister_object(this._dbusId);
        this._dbusId = null;
        Gio.bus_unown_name(this._nameId);
        this._nameId = null;

        this._loftTitleKeys.clear();
        this._loftTitleKeys = null;
    }

    _callServiceMethod(segment, method, signature, args) {
        Gio.DBus.session.call(
            'chat.loft.Loft', `/chat/loft/${segment}`, 'chat.loft.Service', method,
            signature ? new GLib.Variant(signature, args) : null,
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            null,
            null);
    }

    // Whole-app actions (ShowWindow, ShowHub, SetGlobalDnd, Quit) live on the
    // root object, as opposed to _callServiceMethod's per-service ones.
    // NO_AUTO_START on both: these only make sense against the running app that
    // owns the name, and in a dev checkout the .desktop resolves to a different
    // install.
    _callRootMethod(method, signature, args) {
        Gio.DBus.session.call(
            'chat.loft.Loft', '/chat/loft/Loft', 'chat.loft.Loft', method,
            signature ? new GLib.Variant(signature, args) : null,
            null,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            null,
            null);
    }

    _registerCombined(iconName) {
        this._unregisterCombined();

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

        const badge = new St.Widget({
            style: `background-color: ${UNREAD_COLOR}; border-radius: ${BADGE_SIZE / 2}px; width: ${BADGE_SIZE}px; height: ${BADGE_SIZE}px;`,
            visible: false,
        });
        box.add_child(badge);

        const dndBadge = new St.Widget({
            style: `background-color: ${DND_COLOR}; border-radius: ${DND_DASH_HEIGHT / 2}px; width: ${DND_DASH_WIDTH}px; height: ${DND_DASH_HEIGHT}px;`,
            visible: false,
        });
        box.add_child(dndBadge);

        // BinLayout alignment is unreliable for overlays, so the unread dot and
        // DND dash are positioned from the icon's own allocation instead.
        icon.connectObject('notify::allocation', () => {
            badge.set_position(
                icon.x + icon.width - BADGE_SIZE,
                icon.y + icon.height - BADGE_SIZE);
            dndBadge.set_position(
                icon.x + icon.width - DND_DASH_WIDTH,
                icon.y + icon.height - DND_DASH_HEIGHT);
        }, this);

        Main.panel.addToStatusArea('loft-combined', indicator);

        this._combinedIndicator = indicator;
        this._combinedIcon = icon;
        this._combinedBadge = badge;
        this._combinedDndBadge = dndBadge;

        // Drop the panel icon if Loft exits. name_vanished also fires when the
        // name does not exist yet, so only react once it has appeared.
        let nameAppeared = false;
        this._combinedWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'chat.loft.Loft',
            Gio.BusNameWatcherFlags.NONE,
            () => {
                nameAppeared = true;
            },
            () => {
                if (nameAppeared)
                    this._unregisterCombined();
            });

        this._rebuildCombinedMenu();
        // The badges are born hidden, so current state has to be reconciled
        // here: Loft pushes UpdateCombinedService only for running services, and
        // at startup there usually are none, making this the only thing that
        // renders the global-DND dash on a fresh icon.
        this._updateCombinedBadges();
    }

    _unregisterCombined() {
        // The flag describes an icon that no longer exists. Leaving it set would
        // make Loft's next post-register push look like a no-op change, and the
        // dash would never render — enable() does not re-run when Loft restarts,
        // only when the shell does.
        this._combinedGlobalDnd = false;

        if (this._combinedWatchId) {
            Gio.bus_unwatch_name(this._combinedWatchId);
            this._combinedWatchId = null;
        }

        this._combinedIcon?.disconnectObject(this);
        this._combinedDndBadge?.destroy();
        this._combinedDndBadge = null;
        this._combinedBadge?.destroy();
        this._combinedBadge = null;
        this._combinedIcon?.destroy();
        this._combinedIcon = null;
        this._combinedIndicator?.destroy();
        this._combinedIndicator = null;

        this._combinedServices?.clear();
        this._combinedAvailable?.clear();
    }

    _updateCombinedService(name, displayName, visible, badge, dnd) {
        const existing = this._combinedServices.get(name);
        if (existing &&
            existing.displayName === displayName &&
            existing.visible === visible &&
            existing.badge === badge &&
            existing.dnd === dnd)
            return;

        // `name` is the D-Bus segment Loft pushed. It is stashed on the row so
        // the menu builder can call back on it without re-deriving it from the
        // display name, which breaks as soon as an account is renamed: the
        // object path is pinned to the kind's default name, not the label.
        this._combinedServices.set(name, {name, displayName, visible, badge, dnd});
        // A service that is running cannot also be in the available section.
        this._combinedAvailable.delete(name);
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _removeCombinedService(name) {
        if (!this._combinedServices.delete(name))
            return;
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _updateAvailableService(name, displayName) {
        // Running wins its own push, so a service declared available drops any
        // stale running row. If that actually removed one, the menu must rebuild
        // even when the available display name is unchanged — hence wasRunning
        // gating the no-op check.
        const wasRunning = this._combinedServices.delete(name);
        if (!wasRunning && this._combinedAvailable.get(name)?.displayName === displayName)
            return;
        this._combinedAvailable.set(name, {name, displayName});
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _removeAvailableService(name) {
        if (!this._combinedAvailable.delete(name))
            return;
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _addServiceRow(menu, svc) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

        const row = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(row);

        row.add_child(new St.Label({
            text: svc.displayName,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        // Global DND mutes every service, so it hides every dot — matching
        // TrayModel.menuModel()'s `unread` for the SNI backend.
        if (svc.badge > 0 && !svc.dnd && !this._combinedGlobalDnd) {
            row.add_child(new St.Label({
                text: ' •',
                style: `color: ${UNREAD_COLOR}; font-size: 16px;`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const showHideIcon = svc.visible ? 'hide-window-symbolic' : 'show-window-symbolic';
        const showHideFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'icons', `${showHideIcon}.svg`]));
        const showHideBtn = new St.Button({
            child: new St.Icon({gicon: new Gio.FileIcon({file: showHideFile}), icon_size: 16}),
            style_class: 'button',
            style: 'margin-left: 12px; padding: 2px 6px;',
            can_focus: true,
        });
        showHideBtn.connect('clicked', () => {
            this._callServiceMethod(svc.name, 'Toggle');
            menu.close();
        });
        row.add_child(showHideBtn);

        const dndBtn = new St.Button({
            child: new St.Icon({
                icon_name: svc.dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                icon_size: 16,
            }),
            style_class: 'button',
            style: `margin-left: 4px; padding: 2px 6px;${svc.dnd ? ' opacity: 128;' : ''}`,
            can_focus: true,
        });
        dndBtn.connect('clicked', () => {
            this._callServiceMethod(svc.name, 'SetDnd', '(b)', [!svc.dnd]);
        });
        row.add_child(dndBtn);

        const quitBtn = new St.Button({
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
            style_class: 'button',
            style: 'margin-left: 4px; padding: 2px 6px;',
            can_focus: true,
        });
        quitBtn.connect('clicked', () => {
            this._callServiceMethod(svc.name, 'Quit');
            menu.close();
        });
        row.add_child(quitBtn);

        menu.addMenuItem(item);
    }

    // Layout, matching the SNI backend's menu (src/main/tray/dbusMenu.ts):
    //   Show Window
    //   Do Not Disturb
    //   ----
    //   <running service rows>   name + unread dot + [Show/Hide] [DND] [Quit]
    //   ----
    //   <available launch rows>
    //   ----
    //   Loft Settings…
    //   Quit Loft
    _rebuildCombinedMenu() {
        if (!this._combinedIndicator)
            return;

        const menu = this._combinedIndicator.menu;
        menu.removeAll();

        // Show the Loft window as it was left. Deliberately not ShowHub, which
        // switches to the manager first and so could never bring the user back
        // to the tab they were on.
        const showWindowItem = new PopupMenu.PopupMenuItem('Show Window');
        showWindowItem.connect('activate', () => {
            this._callRootMethod('ShowWindow');
        });
        menu.addMenuItem(showWindowItem);

        const globalDndItem = new PopupMenu.PopupSwitchMenuItem(
            'Do Not Disturb', this._combinedGlobalDnd);
        globalDndItem.connect('toggled', (_item, state) => {
            this._callRootMethod('SetGlobalDnd', '(b)', [state]);
        });
        menu.addMenuItem(globalDndItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const svc of this._combinedServices.values())
            this._addServiceRow(menu, svc);

        // Available services get a plain launch row — no DND or Quit — calling
        // the service's Show() to start it. Parity with the SNI menu.
        if (this._combinedAvailable.size > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const avail of this._combinedAvailable.values()) {
                const launchItem = new PopupMenu.PopupMenuItem(avail.displayName);
                launchItem.connect('activate', () => {
                    this._callServiceMethod(avail.name, 'Show');
                    menu.close();
                });
                menu.addMenuItem(launchItem);
            }
        }

        if (this._combinedServices.size === 0 && this._combinedAvailable.size === 0)
            menu.addMenuItem(new PopupMenu.PopupMenuItem('No services configured', {reactive: false}));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Loft Settings…');
        settingsItem.connect('activate', () => {
            this._callRootMethod('ShowHub');
        });
        menu.addMenuItem(settingsItem);

        // Whole-app quit (every window plus the process), not a per-service
        // quit — that is the ✕ button on each service row.
        const quitItem = new PopupMenu.PopupMenuItem('Quit Loft');
        quitItem.connect('activate', () => {
            this._callRootMethod('Quit');
        });
        menu.addMenuItem(quitItem);
    }

    _updateGlobalDnd(enabled) {
        if (this._combinedGlobalDnd === enabled)
            return;
        this._combinedGlobalDnd = enabled;
        this._rebuildCombinedMenu();
        this._updateCombinedBadges();
    }

    _updateCombinedBadges() {
        if (!this._combinedIndicator)
            return;

        let anyBadge = false;
        let allDnd = this._combinedServices.size > 0;

        for (const svc of this._combinedServices.values()) {
            if (svc.badge > 0 && !svc.dnd)
                anyBadge = true;
            if (!svc.dnd)
                allDnd = false;
        }

        // Global DND mutes everything, so it shows the dash however many
        // services are running (TrayModel.iconOverlay(), same rule).
        if (this._combinedGlobalDnd)
            allDnd = true;

        this._combinedBadge.visible = anyBadge && !allDnd;
        this._combinedDndBadge.visible = allDnd;
    }

    _findWindow(key) {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (titleMatchesKey(win.get_title() ?? '', key))
                return win;
        }
        return null;
    }

    _focusWindow(key) {
        const win = this._findWindow(key);
        if (!win)
            return false;

        if (win.minimized)
            win.unminimize();
        // Move the window to the current workspace first, so activate() does not
        // trip focus-stealing prevention and bounce the user to the window's old
        // workspace.
        const currentWs = global.workspace_manager.get_active_workspace();
        if (win.get_workspace() !== currentWs)
            win.change_workspace(currentWs);
        win.activate(global.get_current_time());
        // An explicit Show from within the overview should take the user to the
        // window. activate() focuses it but, being a raw compositor activation,
        // does not dismiss the overview, so the window would stay out of sight
        // until the user left the overview by hand.
        if (Main.overview.visible)
            Main.overview.hide();
        return true;
    }

    _hideWindow(key) {
        const win = this._findWindow(key);
        if (!win)
            return false;
        win.minimize();
        return true;
    }

    _onMethodCall(method, params, invocation) {
        switch (method) {
        case 'FocusWindow': {
            const [key] = params.deep_unpack();
            invocation.return_value(GLib.Variant.new('(b)', [this._focusWindow(key)]));
            return;
        }
        case 'HideWindow': {
            const [key] = params.deep_unpack();
            invocation.return_value(GLib.Variant.new('(b)', [this._hideWindow(key)]));
            return;
        }
        case 'SetLoftWindows': {
            const [keys] = params.deep_unpack();
            this._loftTitleKeys.clear();
            for (const key of keys)
                this._loftTitleKeys.add(key);
            break;
        }
        case 'RegisterCombined': {
            const [iconName] = params.deep_unpack();
            this._registerCombined(iconName);
            break;
        }
        case 'UnregisterCombined':
            this._unregisterCombined();
            break;
        case 'UpdateCombinedService': {
            const [name, displayName, visible, badge, dnd] = params.deep_unpack();
            this._updateCombinedService(name, displayName, visible, badge, dnd);
            break;
        }
        case 'RemoveCombinedService': {
            const [name] = params.deep_unpack();
            this._removeCombinedService(name);
            break;
        }
        case 'UpdateAvailableService': {
            const [name, displayName] = params.deep_unpack();
            this._updateAvailableService(name, displayName);
            break;
        }
        case 'RemoveAvailableService': {
            const [name] = params.deep_unpack();
            this._removeAvailableService(name);
            break;
        }
        case 'UpdateGlobalDnd': {
            const [enabled] = params.deep_unpack();
            this._updateGlobalDnd(enabled);
            break;
        }
        default:
            invocation.return_dbus_error(
                'org.freedesktop.DBus.Error.UnknownMethod',
                `Unknown method: ${method}`);
            return;
        }

        invocation.return_value(null);
    }
}
