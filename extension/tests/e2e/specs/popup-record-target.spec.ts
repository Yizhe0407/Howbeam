import { test, expect } from '../support/fixture';
import { resetExtensionData, seedAndSelectProject } from '../support/harness';

const LONG_TITLE = '未命名專案 · 2026年10月15日 下午3:37 · 一段非常長的標題用來測試選單不會超出視窗';

test.describe('popup record target picker', () => {
  test('keeps the option list inside the 320px popup, however long a project title is', async ({ popupPage, browserErrors }) => {
    await resetExtensionData(popupPage);
    await seedAndSelectProject(popupPage, LONG_TITLE);
    await seedAndSelectProject(popupPage, `${LONG_TITLE}（第二份）`);
    await popupPage.reload({ waitUntil: 'domcontentloaded' });

    const trigger = popupPage.getByRole('combobox', { name: '錄到哪裡' });
    // Measured before opening: an open Select marks the rest of the page aria-hidden.
    const triggerBox = await trigger.boundingBox();
    await trigger.click();
    const list = popupPage.getByRole('listbox');
    await expect(list).toBeVisible();

    const listBox = await list.boundingBox();
    // The popup clips whatever is drawn past its edge, so the list must never be wider than, or stick out of, the trigger.
    expect(listBox!.x).toBeGreaterThanOrEqual(triggerBox!.x - 1);
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(triggerBox!.x + triggerBox!.width + 1);

    // Truncated titles still leave the screen count readable on every option.
    for (const option of await list.getByRole('option').all()) {
      const box = await option.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(triggerBox!.x + triggerBox!.width + 1);
    }
    for (const option of await list.getByRole('option').all()) {
      const count = option.getByText('0 個步驟');
      if (await count.count() === 0) continue;
      // The count is the last thing on the row and must stay inside it.
      const [countBox, optionBox] = [await count.boundingBox(), await option.boundingBox()];
      expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(optionBox!.x + optionBox!.width + 1);
    }
    await expect(list.getByText('0 個步驟')).toHaveCount(3);
    expect(browserErrors).toEqual([]);
  });
});
