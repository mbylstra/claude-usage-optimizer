import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupRoot } from './PopupRoot';
import '@/index.css';

/**
 * Follow the OS theme. The popup is too small and too short-lived to justify a
 * theme setting of its own.
 */
function applySystemTheme(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => document.documentElement.classList.toggle('dark', prefersDark.matches);

  sync();
  prefersDark.addEventListener('change', sync);
}

applySystemTheme();

const container = document.getElementById('root');
if (container === null) throw new Error('Popup root element is missing');

createRoot(container).render(
  <StrictMode>
    <PopupRoot />
  </StrictMode>,
);
