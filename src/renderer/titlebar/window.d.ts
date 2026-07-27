interface Window {
  loft: {
    zoomIn(): void;
    zoomOut(): void;
    close(): void;
    reload(): void;
    onSetService(cb: (name: string) => void): void;
    attach(): void;
    addToGrid(): void;
    pin(): void;
    onSetCanPin(cb: (canPin: boolean) => void): void;
    onSetAttachable(cb: (id: string | null) => void): void;
    onSetContext(cb: (id: string | null, iconEpoch: number) => void): void;
  };
}
