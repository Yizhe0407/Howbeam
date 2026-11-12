// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { controlKindOf, generateActionDescription, isControlKind, type ControlKind } from '@/lib/capture/action-description';
import { t } from '@/lib/shared/i18n';

function element(html: string, selector = '[data-target]'): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe('controlKindOf', () => {
  it.each<[string, ControlKind]>([
    ['<a data-target href="/x">Account 8842</a>', 'link'],
    ['<a data-target href="/x" target="_blank">Open</a>', 'link-new-tab'],
    ['<select data-target><option>a</option></select>', 'select'],
    ['<textarea data-target></textarea>', 'text-field'],
    ['<input data-target type="email">', 'text-field'],
    ['<input data-target type="checkbox">', 'checkbox'],
    ['<input data-target type="radio">', 'radio'],
    ['<input data-target type="submit">', 'submit'],
    ['<input data-target type="range">', 'input'],
    ['<form><button data-target>Send</button></form>', 'submit'],
    ['<button data-target>Send</button>', 'button'],
    ['<form><button data-target type="button">Help</button></form>', 'button'],
    ['<details><summary data-target>More</summary></details>', 'disclosure'],
    ['<label data-target><input type="checkbox"> Remember me</label>', 'checkbox'],
    ['<label data-target for="name">Name</label><input id="name">', 'label'],
    ['<div data-target role="switch">Dark mode</div>', 'checkbox'],
    ['<div data-target role="button">Go</div>', 'button'],
    ['<span data-target role="link">Docs</span>', 'link'],
    ['<div data-target contenteditable="true">Notes</div>', 'text-field'],
    ['<div data-target>Submit form</div>', 'element'],
  ])('reads %s as %s from the element, not its text', (html, expected) => {
    expect(controlKindOf(element(html))).toBe(expected);
  });
});

describe('generateActionDescription', () => {
  it('describes a mark as a marked region, whatever was under it', () => {
    expect(generateActionDescription({ intent: 'mark', control: 'link' })).toBe(t().capture.markRegion);
  });

  it.each<[ControlKind, string]>([
    ['link', t().capture.openLink],
    ['link-new-tab', t().capture.openNewTab],
    ['select', t().capture.selectOption],
    ['text-field', t().capture.typeInField],
    ['checkbox', t().capture.toggleCheckbox],
    ['radio', t().capture.selectRadio],
    ['submit', t().capture.submitForm],
    ['button', t().capture.clickButton],
    ['input', t().capture.useInput],
    ['disclosure', t().capture.toggleDisclosure],
    ['label', t().capture.clickLabel],
    ['element', t().capture.clickElement],
  ])('describes a %s click', (control, expected) => {
    expect(generateActionDescription({ intent: 'click', control })).toBe(expected);
  });

  it('accepts only known control kinds from a message', () => {
    expect(isControlKind('checkbox')).toBe(true);
    expect(isControlKind('Account 8842')).toBe(false);
  });
});
