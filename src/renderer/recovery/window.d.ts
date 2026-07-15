export {};
declare global {
  interface Window {
    loftRecovery: {
      reload(): void;
      clearAndReload(): void;
      onSetService(cb: (name: string) => void): void;
    };
  }
}
