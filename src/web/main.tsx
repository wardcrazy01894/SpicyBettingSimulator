/** SPA bootstrap. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installDiagnostics } from './diagnostics.js';
import './styles.css';

// Before anything else can throw: the diagnostics log attached to bug reports
// (PLAN.md §11.7) captures uncaught errors from the very first frame.
installDiagnostics();

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
