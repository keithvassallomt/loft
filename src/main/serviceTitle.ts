export function formatWindowTitle(name: string, count: number): string {
  return Number.isFinite(count) && count > 0 ? `${name} (${count})` : name;
}
