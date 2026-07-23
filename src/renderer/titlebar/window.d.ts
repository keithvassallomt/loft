interface Window {
  loft: {
    zoomIn(): void;
    zoomOut(): void;
    close(): void;
    reload(): void;
    onSetService(cb: (name: string) => void): void;
    attach(): void;
    addToGrid(): void;
    onSetAttachable(cb: (id: string | null) => void): void;
    onSetContext(cb: (id: string | null) => void): void;
  };
}
