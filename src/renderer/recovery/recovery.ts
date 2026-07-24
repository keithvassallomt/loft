document.getElementById('reload')!.addEventListener('click', () => window.loftRecovery.reload());
document.getElementById('clear')!.addEventListener('click', () => window.loftRecovery.clearAndReload());

// Main sends the service display name once the overlay has finished loading.
const titleEl = document.getElementById('title')!;
window.loftRecovery.onSetService((name: string) => {
  titleEl.textContent = `${name} didn't load.`;
});
