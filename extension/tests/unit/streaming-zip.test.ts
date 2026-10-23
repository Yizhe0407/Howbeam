import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildZipBlob, paddedZipOrdinal } from '@/lib/export/streaming-zip';
import { valueAt } from '../setup/item-at';

describe('streaming zip helper', () => {
  it('builds a ZIP Blob containing exactly the files the builder added', async () => {
    const blob = await buildZipBlob((addFile) => {
      addFile('01.jpg', strToU8('first-image'));
      addFile('docs/project.md', strToU8('# project'));
    });

    expect(blob.type).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['01.jpg', 'docs/project.md']);
    expect(strFromU8(valueAt(files, '01.jpg'))).toBe('first-image');
    expect(strFromU8(valueAt(files, 'docs/project.md'))).toBe('# project');
  });

  it('supports an async builder that interleaves awaits between files', async () => {
    const blob = await buildZipBlob(async (addFile) => {
      addFile('a.txt', strToU8('a'));
      await Promise.resolve();
      addFile('b.txt', strToU8('b'));
    });

    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('terminates the stream and rethrows the builder failure without an unhandled rejection', async () => {
    const failure = new Error('composite failed');

    await expect(
      buildZipBlob(async (addFile) => {
        addFile('01.jpg', strToU8('partial'));
        throw failure;
      }),
    ).rejects.toBe(failure);

    // The internal stream promise must already be observed; an unobserved
    // rejection would fail this test run once the macrotask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('pads ZIP ordinals to at least two digits', () => {
    expect(paddedZipOrdinal(1, 3)).toBe('01');
    expect(paddedZipOrdinal(7, 42)).toBe('07');
    expect(paddedZipOrdinal(12, 100)).toBe('012');
  });
});
