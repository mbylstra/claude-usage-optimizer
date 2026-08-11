import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RunLogRoot } from './RunLogRoot';
import { applySystemTheme } from '@/lib/applySystemTheme';
import '@/index.css';

applySystemTheme();

const container = document.getElementById('root');
if (container === null) throw new Error('Run log root element is missing');

createRoot(container).render(
  <StrictMode>
    <RunLogRoot />
  </StrictMode>,
);
