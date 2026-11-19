import { describe, expect, it } from 'vitest';
import { generateActionTitle, type ActionTitleCapture } from '@/lib/capture/action-title';

function capture(overrides: Partial<ActionTitleCapture> = {}): ActionTitleCapture {
  return {
    intent: 'click',
    tagName: 'div',
    text: '',
    ...overrides,
  };
}

describe('generateActionTitle', () => {
  it('leaves a mark untitled, whatever the marked area says', () => {
    expect(generateActionTitle(capture({
      intent: 'mark',
      tagName: 'section',
      text: 'Account 8842 has a balance of $9,999',
    }))).toBe('');
  });

  it.each([
    ['button', 'Generate', '點擊 Generate'],
    ['textarea', 'Notes', '在 Notes 欄位輸入'],
    ['input', 'Email', '在 Email 欄位輸入'],
    ['select', 'Type', '在 Type 選擇選項'],
    ['option', 'Month', '在 Month 選擇選項'],
    ['summary', 'Advanced', '展開 Advanced'],
    ['label', 'Department', '點擊 Department'],
    ['a', 'Back To Home', '開啟 Back To Home'],
    ['div', 'Submit form', '點擊 Submit form'],
  ])('names the <%s> by its text', (tagName, text, expected) => {
    expect(generateActionTitle(capture({ tagName, text }))).toBe(expected);
  });

  it('only claims a new tab when the link says so', () => {
    expect(generateActionTitle(capture({ tagName: 'A', text: 'Open in a new tab' }))).toBe('開啟新分頁');
  });

  it('prefers native tag semantics over incidental words in a label', () => {
    expect(generateActionTitle(capture({ tagName: 'a', text: 'Checkbox documentation' })))
      .toBe('開啟 Checkbox documentation');
    expect(generateActionTitle(capture({ tagName: 'button', text: 'Radio settings' })))
      .toBe('點擊 Radio settings');
  });

  it.each([
    ['input', '核取方塊 記住我', '勾選 核取方塊 記住我'],
    ['label', 'Radio button A', '選取 Radio button A'],
    ['x-checkbox', 'Enable feature', '勾選 Enable feature'],
  ])('recognizes a checkbox or radio hint on <%s>', (tagName, text, expected) => {
    expect(generateActionTitle(capture({ tagName, text }))).toBe(expected);
  });

  it('gives an unnamed element no title instead of a generic one', () => {
    expect(generateActionTitle(capture({ tagName: 'button', text: '   ' }))).toBe('');
  });

  it('keeps the title on one line and cuts a long name', () => {
    const title = generateActionTitle(capture({ tagName: 'button', text: `Save\n  ${'x'.repeat(60)}` }));

    expect(title).not.toContain('\n');
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual('點擊 '.length + 41);
  });
});
