import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { RailState } from '../main/railModel';
import type { RailSlot } from '../main/railSlots';

export interface RailBridge {
  /** Subscribe to rail state. Returns an unsubscribe — call it on teardown. */
  onState(cb: (state: RailState) => void): () => void;
  select(id: string): void;
  /** Ask main to pop the native per-service context menu for this item. */
  menu(id: string): void;
  /** Go to a pinned conversation: main resolves the service and navigates it. */
  selectBubble(id: string): void;
  /** Pop the per-bubble context menu (Remove). */
  bubbleMenu(id: string): void;
  /** Hand main the bubbles' geometry at drag start, as dragBegin does for services. */
  bubbleDragBegin(slots: RailSlot[], id: string): void;
  /** Live pointer position during a bubble drag. */
  bubbleDragMove(clientY: number): void;
  /** Release at `clientY`, or null for an aborted gesture — main must drop its state either
   *  way, or the next drag measures against stale geometry. */
  bubbleDragEnd(clientY: number | null): void;
  /** Open the manager view (the rail's Loft "home" button). */
  showManager(): void;
  /** Open the grid view (the rail's pinned Grid button). */
  showGrid(): void;
  /** Report a drag that ended on a service icon; main decides the outcome from the release. */
  dragEnd(id: string, releaseX: number, releaseY: number): void;
  /** Hand main the rail's icon geometry at drag start; it computes insertion indices from it.
   *  `id` is the dragged service where the gesture knows it — omitted for a cross-window
   *  HTML5 drag, whose id the browser withholds until 'drop'. */
  dragBegin(slots: RailSlot[], id?: string): void;
  /** Live pointer/dragover position during a drag. */
  dragMove(clientX: number, clientY: number): void;
  /** The gesture was aborted (pointercancel), not released — main must drop its drag state
   *  and hide the drop preview, which would otherwise sit there eating every click. */
  dragCancel(): void;
  /** A cross-window HTML5 drop landed on the rail — attach this service at this position. */
  dropAttach(id: string, clientY: number): void;
  /** Insertion index to draw the indicator at; -1 hides it. Returns an unsubscribe. */
  onDropSlot(cb: (index: number) => void): () => void;
}

/** Pure factory so the bridge is testable against a fake ipc (mirrors preload/hub.ts). */
export function buildRailBridge(ipc: IpcRenderer): RailBridge {
  return {
    onState(cb) {
      const h = (_e: unknown, state: RailState): void => cb(state);
      ipc.on('rail:state', h);
      return () => ipc.removeListener('rail:state', h);
    },
    select: (id) => ipc.send('rail:select', id),
    menu: (id) => ipc.send('rail:menu', id),
    selectBubble: (id) => ipc.send('rail:selectBubble', id),
    bubbleMenu: (id) => ipc.send('rail:bubbleMenu', id),
    bubbleDragBegin: (slots, id) => ipc.send('rail:bubbleDragBegin', { slots, id }),
    bubbleDragMove: (clientY) => ipc.send('rail:bubbleDragMove', clientY),
    bubbleDragEnd: (clientY) => ipc.send('rail:bubbleDragEnd', clientY),
    showManager: () => ipc.send('rail:showManager'),
    showGrid: () => ipc.send('rail:showGrid'),
    dragEnd: (id, releaseX, releaseY) => ipc.send('rail:dragEnd', { id, releaseX, releaseY }),
    dragBegin: (slots, id) => ipc.send('rail:dragBegin', { slots, id }),
    dragMove: (clientX, clientY) => ipc.send('rail:dragMove', { clientX, clientY }),
    dragCancel: () => ipc.send('rail:dragCancel'),
    dropAttach: (id, clientY) => ipc.send('rail:dropAttach', { id, clientY }),
    onDropSlot(cb) {
      const h = (_e: unknown, index: number): void => cb(index);
      ipc.on('rail:dropSlot', h);
      return () => ipc.removeListener('rail:dropSlot', h);
    },
  };
}

contextBridge.exposeInMainWorld('loftRail', buildRailBridge(ipcRenderer));
