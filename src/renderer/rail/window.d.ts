import type { RailBridge } from '../../preload/rail';
declare global {
  interface Window { loftRail: RailBridge }
}
export {};
