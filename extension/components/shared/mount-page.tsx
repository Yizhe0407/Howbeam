import React, { type ComponentType } from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@/assets/tailwind.css';
import { localizeDocument, onLocaleChange, t, useActiveLocale, type Messages } from '@/lib/shared/i18n';
import { initLocalePreference } from '@/lib/runtime/locale-preference';

type PageKey = 'editor' | 'library' | 'options' | 'popup' | 'welcome';

/**
 * Mounts an extension page: its stored language is resolved before the first
 * paint, the document title and language follow the language, and the whole
 * page re-renders when it changes (every component reads its copy through t()).
 */
export function mountPage(App: ComponentType, page: PageKey, errorLabel: (messages: Messages) => string): void {
  function Root() {
    useActiveLocale();
    return (
      <ErrorBoundary label={errorLabel(t())}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ErrorBoundary>
    );
  }

  void (async () => {
    await initLocalePreference();
    const localize = () => localizeDocument(t().page[page]);
    localize();
    onLocaleChange(localize);
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <Root />
      </React.StrictMode>,
    );
  })();
}
