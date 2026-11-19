// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import OverflowTooltip from '@/components/shared/OverflowTooltip';

/** jsdom has no layout or input modality, so the test sets what a browser would report. */
function asBrowserSees(
  element: HTMLElement,
  { scrollWidth, clientWidth, keyboardFocus }: { scrollWidth: number; clientWidth: number; keyboardFocus: boolean },
) {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
  element.matches = (selector: string) => selector === ':focus-visible' && keyboardFocus;
}

function renderName() {
  render(
    <OverflowTooltip content="一個很長很長的專案名稱">
      <h2 tabIndex={-1}>一個很長很長的專案名稱</h2>
    </OverflowTooltip>,
    { wrapper: TooltipProvider },
  );
  return screen.getByRole('heading');
}

afterEach(cleanup);

describe('OverflowTooltip', () => {
  it('shows the full text when a cut-off name is reached from the keyboard', async () => {
    const name = renderName();
    asBrowserSees(name, { scrollWidth: 300, clientWidth: 120, keyboardFocus: true });

    fireEvent.focus(name);

    expect((await screen.findByRole('tooltip')).textContent).toBe('一個很長很長的專案名稱');
  });

  it('stays closed when the name fits', () => {
    const name = renderName();
    asBrowserSees(name, { scrollWidth: 120, clientWidth: 120, keyboardFocus: true });

    fireEvent.focus(name);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays closed when the page moves focus to a cut-off name itself', () => {
    const name = renderName();
    asBrowserSees(name, { scrollWidth: 300, clientWidth: 120, keyboardFocus: false });

    fireEvent.focus(name);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
