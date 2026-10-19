import { test, expect } from '../support/fixture';
import {
  clickTarget,
  expectSteady,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
  targetCenter,
} from '../support/harness';

/** Gesture fixtures added to the shared fixture page for this spec only. */
async function addGestureFixtures(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.createElement('section');
    host.id = 'gesture-fixtures';
    host.style.cssText = 'position:fixed;left:20px;bottom:20px;width:420px;background:#fff;padding:8px;z-index:10';
    host.innerHTML = `
      <input id="gesture-range" type="range" min="0" max="100" value="0" style="width:300px;display:block">
      <p id="gesture-text" style="font:16px/1.4 sans-serif;margin:8px 0">Alpha bravo charlie delta echo foxtrot</p>
      <button id="gesture-dbl" type="button" style="display:block;margin:8px 0">Double me</button>
      <input id="gesture-input" type="text" value="abcdefghijklmnopqrstuvwxyz" style="width:300px;font:16px monospace">
    `;
    document.body.append(host);
    const counts = { dblclick: 0, click: 0 };
    (window as unknown as { gestureCounts: typeof counts }).gestureCounts = counts;
    const dbl = document.getElementById('gesture-dbl')!;
    dbl.addEventListener('click', () => { counts.click += 1; });
    dbl.addEventListener('dblclick', () => { counts.dblclick += 1; });
  });
}

test.describe('step recording gestures', () => {
  test.beforeEach(async ({ popupPage, appPage }) => {
    await resetExtensionData(popupPage);
    await addGestureFixtures(appPage);
  });

  test('a range slider drags natively and records no step', async ({ appPage, popupPage, browserErrors: _browserErrors }) => {
    await startRecording(appPage, popupPage, 'steps');
    const box = (await appPage.locator('#gesture-range').boundingBox())!;
    await appPage.mouse.move(box.x + 4, box.y + box.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
    await appPage.mouse.up();
    await expect.poll(() => appPage.locator('#gesture-range').inputValue()).not.toBe('0');
    await expectSteady(async () => (await readSteps(popupPage)).length, 0);
    await stopRecording(popupPage);
  });

  test('a text drag selects text and records no step', async ({ appPage, popupPage, browserErrors: _browserErrors }) => {
    await startRecording(appPage, popupPage, 'steps');
    const box = (await appPage.locator('#gesture-text').boundingBox())!;
    await appPage.mouse.move(box.x + 2, box.y + box.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 10 });
    await appPage.mouse.up();
    await expect.poll(() => appPage.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(3);
    await expectSteady(async () => (await readSteps(popupPage)).length, 0);
    await stopRecording(popupPage);
  });

  test('a double click reaches its dblclick handler and records one step', async ({ appPage, popupPage, browserErrors: _browserErrors }) => {
    await startRecording(appPage, popupPage, 'steps');
    const point = await targetCenter(appPage, '#gesture-dbl');
    await appPage.mouse.dblclick(point.x, point.y);
    await expect.poll(() => appPage.evaluate(() => (window as unknown as { gestureCounts: { dblclick: number } }).gestureCounts.dblclick)).toBe(1);
    expect(await appPage.evaluate(() => (window as unknown as { gestureCounts: { click: number } }).gestureCounts.click)).toBe(2);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);
    await stopRecording(popupPage);
  });

  test('a click in a text field puts the caret where the user clicked', async ({ appPage, popupPage, browserErrors: _browserErrors }) => {
    await startRecording(appPage, popupPage, 'steps');
    const box = (await appPage.locator('#gesture-input').boundingBox())!;
    await appPage.mouse.click(box.x + 30, box.y + box.height / 2);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const caret = await appPage.evaluate(() => (document.getElementById('gesture-input') as HTMLInputElement).selectionStart);
    expect(caret).toBeLessThan(10);
    await stopRecording(popupPage);
  });

  test('repeated start/stop cycles reuse one toolbar host', async ({ appPage, popupPage, browserErrors: _browserErrors }) => {
    for (let cycle = 0; cycle < 3; cycle++) {
      // Each cycle runs in the content-script instance the first one created;
      // only one toolbar host may ever exist and none once stopped.
      const before = (await readSteps(popupPage)).length;
      await startRecording(appPage, popupPage, 'steps');
      await clickTarget(appPage, '#plain-text');
      await expect.poll(async () => (await readSteps(popupPage)).length).toBeGreaterThan(before);
      await stopRecording(popupPage);
      await expect.poll(() => appPage.locator('[data-howbeam-recording-toolbar]').count()).toBe(0);
    }
  });
});
