import { describe, expect, it, vi } from 'vitest';

// continuation-tabs imports wxt/browser for its tab helpers; the validation
// under test is pure, so an empty browser object is enough.
vi.mock('wxt/browser', () => ({ browser: {} }));

import { validatePreparedPermissionSource } from '@/lib/editor/continuation-tabs';

describe('validatePreparedPermissionSource', () => {
  it('accepts a plain http(s) origin whose pattern covers exactly that origin', () => {
    expect(() => validatePreparedPermissionSource('https://example.com', 'https://example.com/*')).not.toThrow();
    expect(() =>
      validatePreparedPermissionSource('http://example.com:8080', 'http://example.com:8080/*'),
    ).not.toThrow();
  });

  it('rejects a source origin that is not a parseable URL', () => {
    expect(() => validatePreparedPermissionSource('not a url', 'https://example.com/*')).toThrow(
      '無法取得來源網站的存取權限，已停止操作。請重新整理後再試一次。',
    );
  });

  it('rejects non-http(s) schemes', () => {
    for (const [origin, pattern] of [
      ['chrome-extension://abcdefgh', 'chrome-extension://abcdefgh/*'],
      ['file:///tmp', 'file:///tmp/*'],
      ['ftp://example.com', 'ftp://example.com/*'],
    ] as const) {
      expect(() => validatePreparedPermissionSource(origin, pattern)).toThrow(
        '無法使用這個來源網站的存取權限，已停止操作。請重新整理後再試一次。',
      );
    }
  });

  it('rejects a source that carries more than a bare origin', () => {
    expect(() => validatePreparedPermissionSource('https://example.com/path', 'https://example.com/*')).toThrow(
      '無法使用這個來源網站的存取權限，已停止操作。請重新整理後再試一次。',
    );
    expect(() => validatePreparedPermissionSource('https://user:pass@example.com', 'https://example.com/*')).toThrow(
      '無法使用這個來源網站的存取權限，已停止操作。請重新整理後再試一次。',
    );
  });

  it('rejects a permission pattern that does not cover exactly the origin', () => {
    for (const pattern of [
      'https://example.com/', // missing wildcard
      'https://example.com/*/extra',
      'https://other.example/*', // different host
      '*://example.com/*', // scheme wildcard widens the grant
      'https://*.example.com/*', // subdomain wildcard widens the grant
      '<all_urls>',
    ]) {
      expect(() => validatePreparedPermissionSource('https://example.com', pattern)).toThrow(
        '無法使用這個來源網站的存取權限，已停止操作。請重新整理後再試一次。',
      );
    }
  });
});
