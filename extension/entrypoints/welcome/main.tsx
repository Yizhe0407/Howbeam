import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@/assets/tailwind.css';
import { localizeDocument, onLocaleChange, t, useActiveLocale } from '@/lib/shared/i18n';
import { initLocalePreference } from '@/lib/runtime/locale-preference';

/** Re-renders the whole page when the language changes; every component
 * reads its copy through t() during render. */
function Root() {
  useActiveLocale();
  return (
    <ErrorBoundary label={t().welcome.name}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

void (async () => {
  // Resolve the stored language before the first paint, so the page never
  // flashes in the browser language first.
  await initLocalePreference();
  const localize = () => localizeDocument(t().page.welcome);
  localize();
  onLocaleChange(localize);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
})();
