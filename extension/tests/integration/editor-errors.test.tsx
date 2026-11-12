// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEditorErrors } from '@/lib/editor/editor-errors';

describe('editor errors', () => {
  it('lets one flow clear its error without hiding another flow’s', () => {
    const { result } = renderHook(() => useEditorErrors());
    act(() => result.current.report('save', '說明無法儲存'));
    act(() => result.current.reporterFor('permission')('需要存取權限'));
    expect(result.current.latest(['save', 'permission'])).toBe('需要存取權限');

    act(() => result.current.report('permission', null));
    expect(result.current.latest(['save', 'permission'])).toBe('說明無法儲存');

    act(() => result.current.report('save', null));
    expect(result.current.latest(['save', 'permission'])).toBeNull();
  });

  it('shows only the flows asked for', () => {
    const { result } = renderHook(() => useEditorErrors());
    act(() => result.current.report('recapture', '重拍失敗'));
    expect(result.current.latest(['save', 'mutation'])).toBeNull();
    expect(result.current.latest(['recapture'])).toBe('重拍失敗');
  });
});
