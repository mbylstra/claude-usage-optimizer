/**
 * Follow the OS theme on an extension page.
 *
 * Lives in `lib/` because it is shared by two entry points and touches nothing
 * but `document` — no `chrome.*`, which is the boundary that actually matters
 * here. Neither the popup nor the run-log window is long-lived enough to justify
 * a theme setting of its own.
 */
export function applySystemTheme(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => document.documentElement.classList.toggle('dark', prefersDark.matches);

  sync();
  prefersDark.addEventListener('change', sync);
}
