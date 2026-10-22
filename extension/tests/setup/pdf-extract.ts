export interface ExtractedPage {
  width: number;
  height: number;
  /** The page's text, one string per visual line, top to bottom. */
  lines: string[];
  items: { text: string; x: number; y: number }[];
}

export interface StructureNode {
  role: string;
  alt?: string;
  /** The text the node's content carries, joined. */
  text: string;
  children: StructureNode[];
}

export interface OutlineNode {
  title: string;
  items: OutlineNode[];
}

type PdfJsStructNode = {
  role?: string;
  alt?: string;
  type?: string;
  id?: string;
  children?: PdfJsStructNode[];
};

/** Reads a PDF back with pdf.js: what a viewer would let a person select, copy, search, navigate and have read aloud. */
export async function readPdf(blob: Blob): Promise<{
  pages: ExtractedPage[];
  /** The tagged structure of every page, in reading order. */
  structure: StructureNode[][];
  outline: OutlineNode[];
  title: string | undefined;
  language: string | undefined;
}> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;
  const pages: ExtractedPage[] = [];
  const structure: StructureNode[][] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: true });
    const items = content.items
      .filter((item): item is typeof item & { str: string; transform: number[] } => 'str' in item && item.str !== '')
      .map((item) => ({ text: item.str, x: item.transform[4], y: viewport.height - item.transform[5] }));
    const lines: string[] = [];
    let currentY: number | undefined;
    for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (currentY === undefined || Math.abs(item.y - currentY) > 2) {
        lines.push(item.text);
        currentY = item.y;
      } else {
        lines[lines.length - 1] += item.text;
      }
    }
    pages.push({ width: viewport.width, height: viewport.height, lines, items });

    // Content leaves of the structure tree are keyed by marked-content id; the text items carry the same ids.
    const tree = (await page.getStructTree()) as PdfJsStructNode | null;
    const contentText = new Map<string, string>();
    const open: string[] = [];
    for (const item of content.items) {
      if ('type' in item && item.type === 'beginMarkedContentProps' && 'id' in item && item.id) {
        open.push(String(item.id));
      } else if ('type' in item && item.type === 'beginMarkedContent') {
        open.push('');
      } else if ('type' in item && item.type === 'endMarkedContent') {
        open.pop();
      } else if ('str' in item) {
        const id = open.findLast((candidate) => candidate !== '');
        if (id) contentText.set(id, (contentText.get(id) ?? '') + item.str);
      }
    }
    const convert = (node: PdfJsStructNode): StructureNode => {
      const children = (node.children ?? []).filter((child) => child.role !== undefined).map(convert);
      const own = (node.children ?? []).filter((child) => child.type === 'content').map((child) => contentText.get(String(child.id)) ?? '');
      return { role: node.role ?? '', ...(node.alt ? { alt: node.alt } : {}), text: [...own, ...children.map((child) => child.text)].join(''), children };
    };
    structure.push(tree ? (tree.children ?? []).map(convert) : []);
  }

  const outline = ((await document.getOutline()) ?? []) as { title: string; items: OutlineNode[] }[];
  const toNode = (entry: { title: string; items: unknown[] }): OutlineNode => ({
    title: entry.title,
    items: (entry.items as { title: string; items: unknown[] }[]).map(toNode),
  });
  const metadata = await document.getMetadata();
  const info = metadata.info as { Title?: string; Language?: string };
  return { pages, structure, outline: outline.map(toNode), title: info.Title, language: info.Language };
}
