// SPDX-License-Identifier: GPL-3.0-or-later
// Loft Shell Helper — window management for Loft services.
//
// 1. Exposes a D-Bus interface so the Loft daemon can focus/hide Chrome
//    windows without triggering GNOME's focus-stealing prevention.
// 2. Hides minimized Loft windows from the alt-tab switcher and overview.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';
import {AppSwitcherPopup} from 'resource:///org/gnome/shell/ui/altTab.js';

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
  </interface>
</node>`;

// Save original prototypes for clean restore on disable
const _origIsOverviewWindow = Workspace.prototype._isOverviewWindow;
const _origAppSwitcherInit = AppSwitcherPopup.prototype._init;

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
        // --- D-Bus interface for window focus/hide ---

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

        // --- Hide minimized Loft windows from alt-tab and overview ---

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
    }

    disable() {
        // Restore original prototypes
        Workspace.prototype._isOverviewWindow = _origIsOverviewWindow;
        AppSwitcherPopup.prototype._init = _origAppSwitcherInit;

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
        } else if (method === 'HideWindow') {
            const win = this._findWindow(wmClass);
            if (win) {
                win.minimize();
                invocation.return_value(GLib.Variant.new('(b)', [true]));
            } else {
                invocation.return_value(GLib.Variant.new('(b)', [false]));
            }
        } else {
            invocation.return_dbus_error(
                'org.freedesktop.DBus.Error.UnknownMethod',
                `Unknown method: ${method}`
            );
        }
    }
}
