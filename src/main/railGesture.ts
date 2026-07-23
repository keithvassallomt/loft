import { railGestureOutcome, type RailGesture } from './railDrag';

/** How a rail-originated show must be performed. `preferCell: false` is what makes a gridded
 *  service open FULL SIZE rather than merely focusing its cell — see showService. */
export interface RailShowIntent {
  preferCell: boolean;
}

/**
 * Spec D2: grid membership and rail selection are independent facts. Every show that starts
 * at the rail — a click, a release that ends in a select, the window a detach just made — is
 * the user choosing what to LOOK AT, so it deselects the grid and takes the whole content
 * rect. Only "reveal X" intents (D-Bus Show(), the tray, a notification click) prefer the
 * cell, and none of those come through here.
 *
 * Exported so the rail's context menu ("Go to X") reads the rule from the same place a rail
 * click does, rather than restating it: both are the rail asking for a service, and a menu
 * that disagreed with the icon above it would be the same split-brain this file exists to
 * close.
 */
export const RAIL_SHOW: RailShowIntent = { preferCell: false };

export type RailGestureAction =
  /** Commit the drop the preview promised (the caller re-plans it at the release point). */
  | { kind: 'grid' }
  /** Pull the service into its own window, then show it there. */
  | { kind: 'detach'; show: RailShowIntent }
  /** Move the icon to `toIndex` in the rail order. */
  | { kind: 'reorder'; toIndex: number }
  /** Show the service; no other state changes. */
  | { kind: 'select'; show: RailShowIntent }
  /** Snap back — the gesture asked for something this service cannot do. */
  | { kind: 'none' };

/**
 * What a released rail gesture should DO, as data. railGestureOutcome answers "which kind of
 * gesture was that"; this answers "and therefore what happens to this service", which is the
 * half that used to live inline in index.ts's switch — untested, and consequently wrong: the
 * select branch called showService with its default `preferCell: true`, so a mouse click on a
 * gridded icon focused its cell instead of opening it full-size (spec D2). Only KEYBOARD
 * activation escaped, because that path bypasses the drag machinery entirely (`rail:select`).
 *
 * Keeping the show intent in the returned action, rather than at the call site, is what makes
 * that rule testable at all: it is now a value this function returns, not an argument the
 * caller may forget to pass.
 */
export function railGestureAction(i: RailGesture): RailGestureAction {
  switch (railGestureOutcome(i)) {
    case 'grid':
      return { kind: 'grid' };
    case 'detach':
      return { kind: 'detach', show: RAIL_SHOW };
    case 'reorder':
      return { kind: 'reorder', toIndex: i.toIndex };
    case 'select':
      return { kind: 'select', show: RAIL_SHOW };
    case 'none':
      return { kind: 'none' };
  }
}
