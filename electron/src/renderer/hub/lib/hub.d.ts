import type { HubState, ServicePatch, GlobalPatch } from '../../../shared/hubTypes';

declare global {
  interface Window {
    loftHub: {
      getState(): Promise<HubState>;
      onStateChanged(cb: (s: HubState) => void): () => void;
      openService(id: string): void;
      addService(id: string, customUrl?: string): void;
      removeService(id: string, deleteData: boolean): void;
      setServiceSetting(id: string, patch: ServicePatch): void;
      setGlobal(patch: GlobalPatch): void;
      quit(): void;
    };
  }
}
export {};
