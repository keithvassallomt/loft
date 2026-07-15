interface Window {
  loft: {
    zoomIn(): void;
    zoomOut(): void;
    close(): void;
    reload(): void;
    onSetService(cb: (name: string) => void): void;
  };
}
