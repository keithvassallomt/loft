declare global {
  interface Window {
    loft: {
      zoomIn(): void;
      zoomOut(): void;
      close(): void;
      onSetService(cb: (name: string) => void): void;
    };
  }
}

document.getElementById('zoom-in')!.addEventListener('click', () => window.loft.zoomIn());
document.getElementById('zoom-out')!.addEventListener('click', () => window.loft.zoomOut());
document.getElementById('close')!.addEventListener('click', () => window.loft.close());

// Main sends the service display name once the titlebar has finished loading.
const nameEl = document.getElementById('name')!;
window.loft.onSetService((name: string) => { nameEl.textContent = name; });

export {};
