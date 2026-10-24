import type { ReactNode } from 'react';
import { Camera, Check, Layers, ListOrdered, Pin, Puzzle, ShieldCheck } from 'lucide-react';
import AppHeader from '@/components/shared/AppHeader';
import Mascot from '@/components/shared/Mascot';
import { Button } from '@/components/ui/button';
import { browser } from 'wxt/browser';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import { useToolbarPin } from '@/lib/runtime/use-toolbar-pin';
import { t } from '@/lib/shared/i18n';
import { recordingModeCopy } from '@/lib/recording/recording-mode-copy';

/**
 * Drawn after the browser's own extensions menu so the instruction matches
 * what people see. Colours deliberately follow the theme rather than mimic a
 * specific browser skin; only the shapes need to be recognisable.
 */
function PinIllustration() {
  return (
    <div role="img" aria-label={t().welcome.pinIllustrationLabel} className="relative h-44 rounded-md border-2 border-border-soft bg-surface-raised p-2.5">
      <div className="flex h-9 items-center gap-2 rounded-full bg-secondary px-3" aria-hidden="true">
        <span className="size-3.5 rounded-full bg-muted-foreground/40" />
        <span className="size-3.5 rounded-full bg-muted-foreground/40" />
        <span className="flex-1" />
        <span className="flex size-7 items-center justify-center rounded-full border-2 border-border bg-card text-foreground">
          <Puzzle className="size-4" />
        </span>
        <span className="size-3.5 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="absolute top-14 right-3 w-52 rounded-md border-2 border-border bg-card py-1.5 text-xs" aria-hidden="true">
        <div className="px-3 py-1 text-muted-foreground">{t().welcome.pinMenuTitle}</div>
        <div className="flex items-center gap-2 bg-brand-bg-soft px-3 py-1.5 font-bold">
          <Mascot className="size-4" />
          <span className="flex-1 truncate">Howbeam</span>
          <span className="flex size-6 items-center justify-center rounded-full border-2 border-border bg-tamago text-on-accent">
            <Pin className="size-3" />
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
          <span className="size-4 rounded-full bg-muted-foreground/40" />
          <span className="flex-1 truncate">{t().welcome.pinOtherExtension}</span>
          <Pin className="mx-1.5 size-3.5" />
        </div>
      </div>
    </div>
  );
}

function StepCard({ number, title, done = false, children }: { number: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border-2 border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-base font-bold">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border bg-primary text-xs text-primary-foreground" aria-hidden="true">
          {done ? <Check className="size-3.5" strokeWidth={3} /> : number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Step 1 follows the browser's own pin state: once Howbeam is on the
 * toolbar the instructions give way to a confirmation, and they come back if
 * it is unpinned. A browser that cannot report the state keeps the
 * instructions. The live region announces the switch either way.
 */
function PinStep() {
  const pinned = useToolbarPin() === 'pinned';
  return (
    <StepCard number={1} title={pinned ? t().welcome.pinnedTitle : t().welcome.pinTitle} done={pinned}>
      <div aria-live="polite" className="flex flex-col gap-3">
        {pinned ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{t().welcome.pinnedBody}</p>
        ) : (
          <>
            <PinIllustration />
            <p className="text-sm leading-relaxed text-muted-foreground">{t().welcome.pinBody}</p>
          </>
        )}
      </div>
    </StepCard>
  );
}

/**
 * First-run page, opened once by the background on install. It covers only
 * what someone needs before their first recording: where the extension lives,
 * which mode to pick, and the limits worth knowing up front.
 */
async function closeWelcome() {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
}

export default function App() {
  // Claims this tab as the welcome page, so the background stops treating it
  // as whatever page it showed before.
  useExtensionPageRegistration();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader current={t().welcome.crumb} />

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 sm:px-10">
        <div className="flex items-center gap-4">
          <Mascot className="size-16 sm:size-20" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-2xl leading-tight font-bold sm:text-3xl">{t().welcome.title}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">{t().welcome.intro}</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[1.15fr_1fr_1fr]">
          <PinStep />

          <StepCard number={2} title={t().welcome.modesTitle}>
            <ul className="flex flex-col gap-3">
              {([['steps', ListOrdered], ['snapshot', Camera]] as const).map(([mode, Icon]) => (
                <li key={mode} className="flex flex-col items-start gap-1.5">
                  <span className="inline-flex items-center gap-1.5 text-sm font-bold text-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                    {recordingModeCopy(mode).label}
                  </span>
                  <span className="text-sm leading-relaxed text-muted-foreground">{recordingModeCopy(mode).description}</span>
                </li>
              ))}
            </ul>
          </StepCard>

          <StepCard number={3} title={t().welcome.promisesTitle}>
            <ul className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                {t().welcome.localOnly}
              </li>
              <li className="flex gap-2">
                <Layers className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                {t().welcome.crossTab}
              </li>
            </ul>
          </StepCard>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void closeWelcome()}>{t().welcome.done}</Button>
        </div>
      </main>
    </div>
  );
}
