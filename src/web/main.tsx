import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloading = false;
  let acceptedUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (acceptedUpdate && !reloading) { reloading = true; window.location.reload(); }
  });
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller && window.confirm('An ERP application update is ready. Reload now? Locally committed state is preserved in this browser.')) {
            acceptedUpdate = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('erp-offline-error'));
    });
  });
}
