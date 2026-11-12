// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  detectUnrecordablePage,
  isChildFrameUnrecordable,
  isPdfViewerDocument,
} from '@/lib/recording/content/recordable-page';

function documentWith(html: string, contentType = 'text/html'): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  if (contentType !== 'text/html') Object.defineProperty(doc, 'contentType', { value: contentType });
  return doc;
}

describe('recordable page detection', () => {
  it('flags the built-in PDF viewer by content type or by its lone embed', () => {
    expect(isPdfViewerDocument(documentWith('', 'application/pdf'))).toBe(true);
    expect(isPdfViewerDocument(documentWith('<embed type="application/pdf" src="about:blank">'))).toBe(true);
    expect(isPdfViewerDocument(documentWith('<p>Report</p><embed type="application/pdf">'))).toBe(false);
  });

  it('flags non-web documents, which the background never accepts captures from', () => {
    const page = documentWith('<button>Go</button>');
    expect(detectUnrecordablePage(page, 'file:///Users/me/guide.html')).toBe('non-web');
    expect(detectUnrecordablePage(page, 'data:text/html,hi')).toBe('non-web');
    expect(detectUnrecordablePage(page, 'https://example.com/')).toBeNull();
    expect(detectUnrecordablePage(documentWith('', 'application/pdf'), 'https://example.com/a.pdf')).toBe('pdf-viewer');
  });

  it('judges child frames by the top origin, not their own about:blank URL', () => {
    const frameUnder = (origins: string[]) =>
      ({
        href: 'about:blank',
        ancestorOrigins: Object.assign([...origins], { contains: () => false }),
      }) as unknown as Location;
    expect(isChildFrameUnrecordable(frameUnder(['https://example.com']))).toBe(false);
    expect(isChildFrameUnrecordable(frameUnder(['https://a.test', 'file://']))).toBe(true);
    expect(isChildFrameUnrecordable({ href: 'https://x.test/' } as Location)).toBe(false);
  });
});
