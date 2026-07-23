import type { GridBridge } from '../../preload/grid';
declare global {
  interface Window { loftGrid: GridBridge }
}
export {};
