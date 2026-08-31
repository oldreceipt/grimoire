export function applyOledMode(enabled: boolean | null | undefined): void {
  const root = document.documentElement;
  if (enabled) {
    root.dataset.oled = 'true';
  } else {
    delete root.dataset.oled;
  }
}
