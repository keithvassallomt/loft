import { describe, it, expect } from 'vitest';
import { DbusMenu, type MenuModel } from '../src/main/tray/dbusMenu';
import * as dbus from 'dbus-next';

// Recursively collect every node id from a GetLayout result.
// LayoutNode = [id, props, Variant[]]; each child Variant wraps a LayoutNode.
type LayoutNode = [number, Record<string, dbus.Variant>, dbus.Variant[]];
function collectIds(layout: LayoutNode): number[] {
  const [id, , children] = layout;
  const ids = [id];
  for (const v of children) ids.push(...collectIds(v.value as LayoutNode));
  return ids;
}
function currentIds(menu: DbusMenu): number[] {
  const [, layout] = menu.GetLayout(0, -1, []);
  return collectIds(layout as LayoutNode);
}

const running = (): MenuModel => ({
  globalDnd: false,
  running: [{ id: 'whatsapp', label: 'WhatsApp', unread: false, dnd: false, visible: true }],
  available: [],
});
// Same service, now quit → it moves from the running group to the available group.
// This is the exact transition that shifts which item each integer id maps to.
const afterQuit = (): MenuModel => ({
  globalDnd: false,
  running: [],
  available: [{ id: 'whatsapp', label: 'WhatsApp' }],
});

describe('DbusMenu item ids', () => {
  it('never reuses an item id across rebuilds (KDE plasmashell merges by id)', () => {
    const menu = new DbusMenu();
    menu.setModel(running());
    const first = currentIds(menu).filter((id) => id !== 0); // root (0) is legitimately stable

    menu.setModel(afterQuit());
    const second = currentIds(menu).filter((id) => id !== 0);

    // No id from the first layout may reappear in the second — otherwise KDE's
    // dbusmenu importer merges the new item's props onto the stale cached widget,
    // producing the "Messenger with a checkbox" / "Settings with a separator" corruption.
    const reused = first.filter((id) => second.includes(id));
    expect(reused).toEqual([]);
  });

  it('assigns unique ids within a single layout', () => {
    const menu = new DbusMenu();
    menu.setModel(running());
    const ids = currentIds(menu);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
