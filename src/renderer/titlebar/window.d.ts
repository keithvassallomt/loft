interface Window {
  loft: {
    zoomIn(): void;
    zoomOut(): void;
    close(): void;
    onSetService(cb: (name: string) => void): void;
  };
}
