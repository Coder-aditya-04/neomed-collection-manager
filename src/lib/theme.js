/**
 * Light or dark, remembered.
 *
 * The choice is written to the document element before React mounts (see
 * index.html) so the page never paints light and then flips — that flash is
 * the thing people notice about a theme switcher, and it is entirely avoidable.
 */

const KEY = 'neomed.theme';

export function readTheme() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private windows and blocked storage both throw. Fall through.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember it is not a reason to refuse to apply it.
  }
}
