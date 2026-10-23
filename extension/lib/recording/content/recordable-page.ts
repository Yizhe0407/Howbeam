import { isRecordableTabUrl } from '../../shared/restricted-urls';

/**
 * Why a document the recorder was injected into cannot produce steps:
 * - `pdf-viewer`: the browser's built-in PDF viewer. The document is only a
 *   shell around a plugin frame the extension cannot script, so no click on
 *   the PDF ever reaches the recorder.
 * - `non-web`: anything that is not an http(s) page (file://, data:, ...).
 *   Every layer of the recorder only accepts web pages — the background
 *   rejects capture requests from any other URL outright — so clicks there
 *   would silently vanish.
 */
export type UnrecordablePageReason = 'pdf-viewer' | 'non-web';

export function isPdfViewerDocument(doc: Document): boolean {
  if (doc.contentType === 'application/pdf') return true;
  // Chromium's viewer document is a body holding exactly one PDF embed.
  const body = doc.body;
  const only = body?.children.length === 1 ? body.firstElementChild : null;
  return only?.tagName === 'EMBED' && only.getAttribute('type') === 'application/pdf';
}

/** Classifies the top-level document the recorder runs in. */
export function detectUnrecordablePage(
  doc: Document = document,
  href: string = location.href,
): UnrecordablePageReason | null {
  if (isPdfViewerDocument(doc)) return 'pdf-viewer';
  if (!isRecordableTabUrl(href)) return 'non-web';
  return null;
}

/**
 * True when a child frame sits under a top-level page that cannot be recorded:
 * no top-frame recorder will ever answer its relayed clicks, so instrumenting
 * it would only delay every click by the relay failsafe. Judged by the top
 * origin (`ancestorOrigins`, Chromium-only) rather than the frame's own URL,
 * which may legitimately be about:blank or srcdoc inside a web page.
 */
export function isChildFrameUnrecordable(loc: Location = location): boolean {
  const ancestors = loc.ancestorOrigins;
  const topOrigin = ancestors?.[ancestors.length - 1];
  if (!topOrigin) return false;
  return !topOrigin.startsWith('http://') && !topOrigin.startsWith('https://');
}
