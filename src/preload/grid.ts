import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import type { GridViewState } from '../main/gridLayout';
import type { Rect } from '../main/layout';

export interface GridBridge {
  /** Subscribe to grid chrome state. Returns an unsubscribe — call it on teardown. */
  onState(cb: (state: GridViewState) => void): () => void;
  /** Make this cell the zoom target. */
  focusCell(service: string): void;
  /** Take this service out of the grid; it keeps running and stays in the rail. */
  removeCell(service: string): void;
  /** Open the ＋ "add a service to the grid" menu — the empty state's own ＋ button. Sends
   *  the TITLEBAR's channel on purpose: its handler pops the menu on the Loft window and
   *  reads nothing off the sender, so the two ＋ affordances stay one behaviour rather than
   *  two that can drift. */
  addToGrid(): void;
  /** A header-handle drag began; main resolves the drop from the moves that follow. */
  cellDragBegin(service: string): void;
  /** A gutter drag began, identified by the split it resizes. */
  gutterDragBegin(path: string, dir: 'row' | 'col'): void;
  /** Live pointer position during either drag, in grid-view coordinates. */
  dragMove(x: number, y: number): void;
  /** Release position; main decides the outcome. */
  dragEnd(x: number, y: number): void;
  /** The gesture was aborted (pointercancel), not released. Main must clear exactly what a
   *  dragEnd clears: without it the drag stays tracked and every later pointermove keeps
   *  resizing — the same stranded-gesture bug rail:dragCancel exists to prevent. */
  dragCancel(): void;
  /** The drop preview rectangle, or null to hide it. Returns an unsubscribe.
   *  Shared with the transparent overlay view (src/renderer/gridOverlay), which runs this
   *  same preload — it needs nothing else the bridge offers, and a second preload for one
   *  channel would be a second place to keep the channel names in step. */
  onPreview(
    cb: (r: (Rect & { originX: number; originY: number }) | null) => void,
  ): () => void;
}

/** Pure factory so the bridge is testable against a fake ipc (mirrors preload/rail.ts). */
export function buildGridBridge(ipc: IpcRenderer): GridBridge {
  return {
    onState(cb) {
      const h = (_e: unknown, state: GridViewState): void => cb(state);
      ipc.on('grid:state', h);
      return () => ipc.removeListener('grid:state', h);
    },
    focusCell: (service) => ipc.send('grid:focusCell', service),
    removeCell: (service) => ipc.send('grid:removeCell', service),
    addToGrid: () => ipc.send('titlebar:addToGrid'),
    cellDragBegin: (service) => ipc.send('grid:cellDragBegin', service),
    gutterDragBegin: (path, dir) => ipc.send('grid:gutterDragBegin', { path, dir }),
    dragMove: (x, y) => ipc.send('grid:dragMove', { x, y }),
    dragEnd: (x, y) => ipc.send('grid:dragEnd', { x, y }),
    dragCancel: () => ipc.send('grid:dragCancel'),
    onPreview(cb) {
      const h = (_e: unknown, r: (Rect & { originX: number; originY: number }) | null): void => cb(r);
      ipc.on('grid:preview', h);
      return () => ipc.removeListener('grid:preview', h);
    },
  };
}

contextBridge.exposeInMainWorld('loftGrid', buildGridBridge(ipcRenderer));
