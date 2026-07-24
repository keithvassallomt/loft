import type { HubState, ServicePatch, GlobalPatch, RecoverOpts, OpResult } from '../../../shared/hubTypes';

declare global {
  const __LOFT_VERSION__: string;
  interface Window {
    loftHub: {
      getState(): Promise<HubState>;
      onStateChanged(cb: (s: HubState) => void): () => void;
      openService(id: string): void;
      addService(kind: string, customUrl?: string): void;
      removeService(id: string, deleteData: boolean): void;
      setServiceSetting(id: string, patch: ServicePatch): void;
      renameService(id: string, name: string): Promise<OpResult>;
      setServiceIcon(id: string, choice: string): Promise<OpResult>;
      setGlobal(patch: GlobalPatch): void;
      recoverService(id: string, opts: RecoverOpts): void;
      quit(): void;
      onSelect(cb: (id: string) => void): () => void;
    };
  }
}
export {};
