// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider });
}

const mocks = vi.hoisted(() => ({
  navigateInPlace: vi.fn(),
  registerPage: vi.fn(),
  toolbarPin: vi.fn(() => 'unknown'),
  getCurrentTab: vi.fn(),
  removeTab: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: { tabs: { getCurrent: mocks.getCurrentTab, remove: mocks.removeTab } } }));

vi.mock('@/lib/runtime/page-navigation', () => ({ navigateInPlace: mocks.navigateInPlace }));
vi.mock('@/lib/runtime/use-extension-page-registration', () => ({ useExtensionPageRegistration: mocks.registerPage }));
vi.mock('@/lib/runtime/use-toolbar-pin', () => ({ useToolbarPin: mocks.toolbarPin }));
vi.mock('@/lib/runtime/locale-preference', () => ({
  getLocalePreference: vi.fn().mockResolvedValue('auto'),
  setLocalePreference: vi.fn(),
}));

import OptionsApp from '@/entrypoints/options/App';
import WelcomeApp from '@/entrypoints/welcome/App';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.toolbarPin.mockReturnValue('unknown');
});

afterEach(cleanup);

describe('welcome page', () => {
  it('titles itself in the body under a way back to the library, and closes its own tab when done', async () => {
    mocks.getCurrentTab.mockResolvedValue({ id: 42 });
    render(<WelcomeApp />);

    expect(mocks.registerPage).toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: '目前位置' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '歡迎使用 Howbeam' }).closest('header')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回到專案庫' }));
    expect(mocks.navigateInPlace).toHaveBeenCalledWith('library');

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(mocks.removeTab).toHaveBeenCalledWith(42));
  });

  it('covers pinning, both recording modes and the up-front limits', () => {
    render(<WelcomeApp />);

    expect(screen.getByRole('heading', { level: 2, name: /將 Howbeam 釘選到工具列/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /擴充功能選單/ })).toBeTruthy();
    expect(screen.getByText('每次點擊都會擷取一張截圖，自動編號成一連串操作步驟。')).toBeTruthy();
    expect(screen.getByText('鎖定目前畫面，在同一張截圖上加入多個標註點。')).toBeTruthy();
    expect(screen.getByText('所有截圖只儲存在這台電腦，不會上傳。')).toBeTruthy();
  });

  it('keeps the pin instructions until the browser reports Howbeam as pinned', () => {
    mocks.toolbarPin.mockReturnValue('unpinned');
    const { rerender } = render(<WelcomeApp />);
    expect(screen.getByRole('heading', { level: 2, name: /將 Howbeam 釘選到工具列/ })).toBeTruthy();

    mocks.toolbarPin.mockReturnValue('pinned');
    rerender(<WelcomeApp />);
    expect(screen.getByRole('heading', { level: 2, name: /Howbeam 已釘選到工具列/ })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /擴充功能選單/ })).toBeNull();
    expect(screen.getByText('之後隨時點擊工具列上的 Howbeam 圖示就能開始錄製。')).toBeTruthy();
  });
});

describe('settings page', () => {
  it('marks the gear as the current location instead of a link to itself', () => {
    render(<OptionsApp />);

    expect(screen.getByRole('heading', { level: 1, name: '設定' }).closest('header')).toBeNull();
    const gear = screen.getByRole('button', { name: '設定' });
    expect(gear.getAttribute('aria-current')).toBe('page');
    fireEvent.click(gear);
    expect(mocks.navigateInPlace).not.toHaveBeenCalled();
  });

  it('returns to the library in the same tab from the Howbeam brand', async () => {
    render(<OptionsApp />);

    expect(mocks.registerPage).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Howbeam 專案庫' }));

    await waitFor(() => expect(mocks.navigateInPlace).toHaveBeenCalledWith('library'));
  });

  it('returns to the library in the same tab from the link above its title', () => {
    render(<OptionsApp />);

    fireEvent.click(screen.getByRole('button', { name: '回到專案庫' }));

    expect(mocks.navigateInPlace).toHaveBeenCalledWith('library');
  });

  it('turns into the welcome page on request', () => {
    render(<OptionsApp />);

    fireEvent.click(screen.getByRole('button', { name: /開啟歡迎頁/ }));

    expect(mocks.navigateInPlace).toHaveBeenCalledWith('welcome');
  });
});
