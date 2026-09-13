/** SPA bootstrap. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

export function mount(): void {
  const root = document.getElementById('root');
  if (root === null) throw new Error('#root missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

mount();
