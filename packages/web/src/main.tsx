import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { registerServiceWorker } from './sw/register.js';
import './index.css';

// SPEC.md Section 12, Phase 8 task brief: registered eagerly, before the
// app even renders, so the offline shell starts caching as early as
// possible - see sw/register.ts's own comment on why this is safe to do
// unconditionally, unlike the push permission prompt.
registerServiceWorker();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
