import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupRoot } from './PopupRoot';
import { applySystemTheme } from '@/lib/applySystemTheme';
import '@/index.css';

applySystemTheme();

const container = document.getElementById('root');
if (container === null) throw new Error('Popup root element is missing');

createRoot(container).render(
  <StrictMode>
    <PopupRoot />
  </StrictMode>,
);
