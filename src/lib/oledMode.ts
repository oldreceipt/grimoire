export const DEFAULT_WINDOW_BACKGROUND = '#0f0f0f';
export const OLED_WINDOW_BACKGROUND = '#000000';

export function windowBackgroundColor(enabled: boolean | null | undefined): string {
  return enabled ? OLED_WINDOW_BACKGROUND : DEFAULT_WINDOW_BACKGROUND;
}
