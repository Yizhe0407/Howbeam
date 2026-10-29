import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';

import { type Step } from '@/lib/storage/models';
import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type ProjectArchiveMetadataInput } from '@/lib/export/project-archive-contract';
import {
  ARCHIVE_MANIFEST_PATH,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_MIME_TYPE,
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveError,
  STEP_KEYS,
  archiveScreenshotPath,
} from '@/lib/export/project-archive-contract';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { importProjectArchive } from '@/lib/export/project-archive-import';
import { firstItems, itemAt, valueAt } from '../setup/item-at';

function pngBlob(width = 2, height = 2): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}

function jpegBlob(width = 2, height = 2): Blob {
  return new Blob([new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 255, height & 255, (width >>> 8) & 255, width & 255,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ])], { type: 'image/jpeg' });
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    screenshotBlob: pngBlob(),
    bounds: { x: 12.5, y: -4, width: 100, height: 50 },
    devicePixelRatio: 2,
    description: 'Click the button',
    url: 'https://example.com/path?q=one#section',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** An archive opened up for inspection or tampering: the parsed manifest plus every other file. */
interface OpenArchive {
  manifest: any;
  files: Record<string, Uint8Array>;
}

async function openArchive(blob: Blob): Promise<OpenArchive> {
  const { [ARCHIVE_MANIFEST_PATH]: manifest, ...files } = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  if (!manifest) throw new Error('The archive has no manifest.');
  return { manifest: JSON.parse(strFromU8(manifest)), files };
}

async function archiveObject(
  steps: readonly Step[] = [makeStep()],
  metadata?: ProjectArchiveMetadataInput,
): Promise<OpenArchive> {
  return openArchive(await exportProjectArchive(steps, { metadata }));
}

/** Packs an archive back into a stored ZIP, the only kind import accepts. */
function pack({ manifest, files }: OpenArchive, level: 0 | 6 = 0): Blob {
  const entries: Zippable = { [ARCHIVE_MANIFEST_PATH]: [strToU8(JSON.stringify(manifest)), { level }] };
  for (const [path, bytes] of Object.entries(files)) entries[path] = [bytes, { level }];
  return new Blob([zipSync(entries)]);
}

async function blobBytes(blob: Blob | undefined): Promise<number[] | undefined> {
  return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : undefined;
}

describe('project archive', () => {
  it('round-trips complete Step data, groups, redactions, and binary screenshot Blobs', async () => {
    const ordinary = makeStep({
      id: 'ordinary',
      runId: 'run-1',
      manualBounds: { x: 10, y: 11, width: 90, height: 45 },
      redactions: [
        { id: 'mask-1', kind: 'solid', bounds: { x: 2, y: 3, width: 20, height: 10 } },
      ],
      redactionReviewRequired: false,
      screenshotScale: 1.5,
      description: '<img src=x onerror="globalThis.executed=true"> & editable text',
      captureRevision: 3,
      lastCaptureRunId: 'capture-run-3',
    });
    const anchor = makeStep({
      id: 'anchor',
      order: 1,
      screenshotBlob: jpegBlob(),
      bounds: null,
      groupId: 'anchor',
    });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      bounds: { x: 5, y: 6, width: 7, height: 8 },
      groupId: 'anchor',
      description: 'Annotation',
    });

    const archive = await exportProjectArchive([annotation, anchor, ordinary]);
    expect(archive.type).toBe(PROJECT_ARCHIVE_MIME_TYPE);

    const { manifest, files } = await openArchive(archive);
    expect(manifest).toMatchObject({ format: PROJECT_ARCHIVE_FORMAT, version: PROJECT_ARCHIVE_VERSION, stepCount: 3 });
    expect(manifest.steps.map((step: any) => step.id)).toEqual(['ordinary', 'anchor', 'annotation']);
    expect(manifest.screenshots.map((shot: any) => shot.mediaType)).toEqual(['image/png', 'image/jpeg']);
    expect(Object.keys(files).sort()).toEqual(
      manifest.screenshots.map((shot: any) => archiveScreenshotPath(shot.id, shot.mediaType)).sort(),
    );
    // Screenshots are stored as their original bytes, not re-encoded.
    const [pngShot] = manifest.screenshots;
    expect(Array.from(valueAt(files, archiveScreenshotPath(pngShot.id, pngShot.mediaType)))).toEqual(await blobBytes(ordinary.screenshotBlob));

    const { steps: restored } = await importProjectArchive(archive);
    const expected = [ordinary, anchor, annotation];
    expect(restored.map((step) => step.id)).not.toEqual(expected.map((step) => step.id));
    expect(new Set(restored.map((step) => step.sessionId)).size).toBe(1);
    expect(itemAt(restored, 1).groupId).toBe(itemAt(restored, 1).id);
    expect(itemAt(restored, 2).groupId).toBe(itemAt(restored, 1).id);
    for (let index = 0; index < expected.length; index += 1) {
      expect(restored[index]).toMatchObject({
        order: itemAt(expected, index).order,
        bounds: itemAt(expected, index).bounds,
        devicePixelRatio: itemAt(expected, index).devicePixelRatio,
        description: itemAt(expected, index).description,
        url: itemAt(expected, index).url,
        timestamp: itemAt(expected, index).timestamp,
      });
      expect(await blobBytes(itemAt(restored, index).screenshotBlob)).toEqual(await blobBytes(itemAt(expected, index).screenshotBlob));
      expect(itemAt(restored, index).screenshotBlob?.type).toBe(itemAt(expected, index).screenshotBlob?.type);
      if (itemAt(expected, index).screenshotBlob) expect(itemAt(restored, index).screenshotBlob).not.toBe(itemAt(expected, index).screenshotBlob);
    }
    expect(itemAt(restored, 0).description).toContain('onerror=');
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined();
  });

  it('stores identical screenshots once and gives each step its image back', async () => {
    const first = makeStep({ id: 'first', screenshotBlob: pngBlob(3, 3) });
    const repeat = makeStep({ id: 'repeat', order: 1, screenshotBlob: pngBlob(3, 3) });
    const other = makeStep({ id: 'other', order: 2, screenshotBlob: pngBlob(4, 3) });

    const archive = await exportProjectArchive([first, repeat, other]);
    const { manifest, files } = await openArchive(archive);
    expect(manifest.screenshots).toHaveLength(2);
    expect(Object.keys(files)).toHaveLength(2);
    expect(manifest.steps[0].screenshotId).toBe(manifest.steps[1].screenshotId);
    expect(manifest.steps[2].screenshotId).not.toBe(manifest.steps[0].screenshotId);

    const { steps } = await importProjectArchive(archive);
    expect(await blobBytes(itemAt(steps, 0).screenshotBlob)).toEqual(await blobBytes(first.screenshotBlob));
    expect(await blobBytes(itemAt(steps, 1).screenshotBlob)).toEqual(await blobBytes(first.screenshotBlob));
    expect(await blobBytes(itemAt(steps, 2).screenshotBlob)).toEqual(await blobBytes(other.screenshotBlob));
  });

  it('serializes every field declared in STEP_KEYS instead of silently dropping it', async () => {
    // Between the three steps, every archivable field is populated:
    // screenshotId on image owners, group fields on the snapshot pair, and
    // every optional scalar on the ordinary step.
    const full = makeStep({
      id: 'full',
      runId: 'run-1',
      manualBounds: { x: 1, y: 2, width: 3, height: 4 },
      redactions: [{ id: 'mask-1', kind: 'solid', bounds: { x: 2, y: 3, width: 4, height: 5 } }],
      redactionReviewRequired: false,
      imageEdits: [{ id: 'edit-1', kind: 'rect', bounds: { x: 1, y: 1, width: 5, height: 5 }, width: 2, fill: 'none' as const, color: '#ff4747' }],
      crop: { x: 1, y: 2, width: 30, height: 20 },
      screenshotScale: 1.5,
      captureRevision: 3,
      imageEditRevision: 4,
      lastCaptureRunId: 'capture-run-3',
    });
    const anchor = makeStep({ id: 'anchor', order: 1, bounds: null, groupId: 'anchor' });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      groupId: 'anchor',
    });

    const { manifest } = await archiveObject([full, anchor, annotation]);
    const serializedKeys = new Set<string>(
      manifest.steps.flatMap((step: Record<string, unknown>) => Object.keys(step)),
    );

    // A serializer that silently drops a STEP_KEYS field would fail here.
    expect([...serializedKeys].sort()).toEqual([...STEP_KEYS].sort());
  });

  it('keeps the image edit revision and rejects a malformed one', async () => {
    const edited = makeStep({ id: 'edited', imageEditRevision: 7 });
    const plain = makeStep({ id: 'plain', order: 1 });
    const { steps } = await importProjectArchive(await exportProjectArchive([edited, plain]));
    expect(itemAt(steps, 0).imageEditRevision).toBe(7);
    expect(itemAt(steps, 1).imageEditRevision).toBeUndefined();

    const malformed = await archiveObject([edited]);
    malformed.manifest.steps[0].imageEditRevision = -1;
    await expect(importProjectArchive(pack(malformed))).rejects.toThrow(/imageEditRevision/);
  });

  it('produces the same manifest regardless of input step order', async () => {
    const first = makeStep({ id: 'b', order: 4, screenshotBlob: pngBlob(2, 3) });
    const second = makeStep({ id: 'a', order: 4, screenshotBlob: pngBlob(3, 2) });

    const forward = await archiveObject([first, second]);
    const reverse = await archiveObject([second, first]);

    expect(JSON.stringify(forward.manifest)).toBe(JSON.stringify(reverse.manifest));
    expect(forward.manifest.steps.map((step: any) => step.id)).toEqual(['a', 'b']);
  });

  it('round-trips metadata, remaps section boundaries, and repairs stale or duplicate sections', async () => {
    const first = makeStep({ id: 'first', order: 0 });
    const anchor = makeStep({ id: 'anchor', order: 1, bounds: null, groupId: 'anchor' });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      groupId: 'anchor',
    });
    const last = makeStep({ id: 'last', order: 3 });
    const archive = await archiveObject([last, annotation, anchor, first], {
      title: 'Safe project',
      description: 'Local backup',
      sections: [
        { id: 'last-section', title: 'Last', startEntryId: 'last' },
        { id: 'first-section', title: '  First\nchapter  ', startEntryId: 'first' },
        { id: 'duplicate-id', title: 'Anchor', startEntryId: 'anchor' },
        { id: 'duplicate-id', title: 'Later duplicate id', startEntryId: 'last' },
        { id: 'duplicate-start', title: 'Later duplicate start', startEntryId: 'first' },
        { id: 'annotation-section', title: 'Must be dropped', startEntryId: 'annotation' },
        { id: 'missing-section', title: 'Must be dropped', startEntryId: 'missing' },
      ],
    });

    expect(archive.manifest.version).toBe(PROJECT_ARCHIVE_VERSION);
    expect(archive.manifest.metadata.sections.map((section: any) => section.startEntryId)).toEqual([
      'first',
      'anchor',
      'last',
    ]);

    const imported = await importProjectArchive(pack(archive));
    const [remappedFirst, remappedAnchor, remappedAnnotation, remappedLast] = firstItems(imported.steps, 4);
    expect(imported.version).toBe(PROJECT_ARCHIVE_VERSION);
    expect(imported.metadata.title).toBe('Safe project');
    expect(imported.metadata.description).toBe('Local backup');
    expect(imported.metadata.sections).toEqual([
      { id: 'first-section', title: 'Firstchapter', startEntryId: remappedFirst.id },
      { id: 'duplicate-id', title: 'Anchor', startEntryId: remappedAnchor.id },
      { id: 'last-section', title: 'Last', startEntryId: remappedLast.id },
    ]);
    expect(remappedAnchor.groupId).toBe(remappedAnchor.id);
    expect(remappedAnnotation.groupId).toBe(remappedAnchor.id);
    expect(imported.metadata.sections.some((section) => section.startEntryId === remappedAnnotation.id)).toBe(false);
    expect(new Set(imported.steps.map((step) => step.sessionId)).size).toBe(1);
    expect(imported.steps.every((step) => !['first', 'anchor', 'annotation', 'last'].includes(step.id))).toBe(true);
  });

  it('repairs duplicate, missing, and annotation-middle sections from an untrusted archive', async () => {
    const first = makeStep({ id: 'first', order: 0 });
    const anchor = makeStep({ id: 'anchor', order: 1, bounds: null, groupId: 'anchor' });
    const annotation = makeStep({
      id: 'annotation',
      order: 2,
      screenshotBlob: undefined,
      groupId: 'anchor',
    });
    const archive = await archiveObject([first, anchor, annotation]);
    archive.manifest.metadata.sections = [
      { id: 'winner', title: 'Winner', startEntryId: 'first' },
      { id: 'winner', title: 'Duplicate id', startEntryId: 'anchor' },
      { id: 'duplicate-start', title: 'Duplicate start', startEntryId: 'first' },
      { id: 'annotation-middle', title: 'Annotation middle', startEntryId: 'annotation' },
      { id: 'missing', title: 'Missing', startEntryId: 'does-not-exist' },
    ];

    const imported = await importProjectArchive(pack(archive));

    expect(imported.metadata.sections).toEqual([
      { id: 'winner', title: 'Winner', startEntryId: itemAt(imported.steps, 0).id },
    ]);
  });

  it('rejects unknown metadata/section fields and oversized metadata', async () => {
    const unknownMetadata = await archiveObject();
    unknownMetadata.manifest.metadata.html = '<script>alert(1)</script>';
    await expect(importProjectArchive(pack(unknownMetadata))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const unknownSection = await archiveObject([makeStep()], {
      sections: [{ id: 'section', title: 'Section', startEntryId: 'step-1' }],
    });
    unknownSection.manifest.metadata.sections[0].style = 'display:none';
    await expect(importProjectArchive(pack(unknownSection))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    await expect(exportProjectArchive([makeStep()], {
      metadata: { title: 'x'.repeat(PROJECT_ARCHIVE_LIMITS.maxTitleLength + 1) },
    })).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const oversizedSection = await archiveObject([makeStep()], {
      sections: [{ id: 'section', title: 'Section', startEntryId: 'step-1' }],
    });
    oversizedSection.manifest.metadata.sections[0].title = 'x'.repeat(
      PROJECT_ARCHIVE_LIMITS.maxSectionTitleLength + 1,
    );
    await expect(importProjectArchive(pack(oversizedSection))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const tooManySections = Array.from({ length: PROJECT_ARCHIVE_LIMITS.maxSections + 1 }, (_, index) => ({
      id: `section-${index}`,
      title: `Section ${index}`,
      startEntryId: 'step-1',
    }));
    await expect(exportProjectArchive([makeStep()], {
      metadata: { sections: tooManySections },
    })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects other versions, files that are not archives, and the old JSON format', async () => {
    const future = await archiveObject();
    future.manifest.version = PROJECT_ARCHIVE_VERSION + 1;
    await expect(importProjectArchive(pack(future))).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

    const older = await archiveObject();
    older.manifest.version = PROJECT_ARCHIVE_VERSION - 1;
    await expect(importProjectArchive(pack(older))).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

    const oldJson = JSON.stringify({ manifest: { format: PROJECT_ARCHIVE_FORMAT, version: 3 }, blobs: [] });
    await expect(importProjectArchive(new Blob([oldJson]))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    await expect(importProjectArchive(new Blob(['<script>globalThis.executed=true</script>']))).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined();

    const noManifest = await archiveObject();
    await expect(importProjectArchive(new Blob([zipSync(
      Object.fromEntries(Object.entries(noManifest.files).map(([path, bytes]) => [path, [bytes, { level: 0 }]])),
    )]))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    await expect(importProjectArchive(new Blob([zipSync({
      [ARCHIVE_MANIFEST_PATH]: [strToU8('{not json'), { level: 0 }],
    })]))).rejects.toMatchObject({ code: 'INVALID_JSON' });
  });

  it('rejects duplicate step, screenshot, and redaction ids', async () => {
    const duplicateSteps = await archiveObject();
    duplicateSteps.manifest.steps.push({ ...duplicateSteps.manifest.steps[0] });
    delete duplicateSteps.manifest.steps[1].screenshotId;
    duplicateSteps.manifest.stepCount = 2;
    await expect(importProjectArchive(pack(duplicateSteps))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });

    const duplicateScreenshots = await archiveObject();
    duplicateScreenshots.manifest.screenshots.push({ ...duplicateScreenshots.manifest.screenshots[0] });
    await expect(importProjectArchive(pack(duplicateScreenshots))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });

    const duplicateRedactions = await archiveObject();
    duplicateRedactions.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'solid', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { id: 'mask', kind: 'solid', bounds: { x: 2, y: 2, width: 1, height: 1 } },
    ];
    await expect(importProjectArchive(pack(duplicateRedactions))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
  });

  it('rejects missing and malformed snapshot group anchors', async () => {
    const missingAnchor = await archiveObject();
    missingAnchor.manifest.steps[0].groupId = 'missing';
    await expect(importProjectArchive(pack(missingAnchor))).rejects.toMatchObject({ code: 'BROKEN_GROUP_REFERENCE' });

    const malformedAnchor = await archiveObject();
    malformedAnchor.manifest.steps[0].groupId = 'step-1';
    await expect(importProjectArchive(pack(malformedAnchor))).rejects.toMatchObject({ code: 'BROKEN_GROUP_REFERENCE' });
  });

  it('rejects malformed redactions and invalid bounds', async () => {
    const badKind = await archiveObject();
    badKind.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'blur', bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    await expect(importProjectArchive(pack(badKind))).rejects.toMatchObject({ code: 'INVALID_REDACTION' });

    const zeroWidth = await archiveObject();
    zeroWidth.manifest.steps[0].redactions = [
      { id: 'mask', kind: 'solid', bounds: { x: 0, y: 0, width: 0, height: 1 } },
    ];
    await expect(importProjectArchive(pack(zeroWidth))).rejects.toMatchObject({ code: 'INVALID_REDACTION' });

    const hugeBounds = await archiveObject();
    hugeBounds.manifest.steps[0].bounds.width = PROJECT_ARCHIVE_LIMITS.maxBoundsDimension + 1;
    await expect(importProjectArchive(pack(hugeBounds))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('rejects unsafe URLs without interpreting HTML-like text', async () => {
    const javascriptUrl = await archiveObject();
    javascriptUrl.manifest.steps[0].url = 'javascript:alert(document.domain)';
    await expect(importProjectArchive(pack(javascriptUrl))).rejects.toMatchObject({ code: 'UNSAFE_URL' });

    const credentialUrl = await archiveObject();
    credentialUrl.manifest.steps[0].url = 'https://user:secret@example.com/private';
    await expect(importProjectArchive(pack(credentialUrl))).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('rejects screenshots that do not match the manifest, unsafe image types, and unused screenshots', async () => {
    const tampered = await archiveObject();
    const path = itemAt(Object.keys(tampered.files), 0);
    const bytes = new Uint8Array(valueAt(tampered.files, path));
    bytes[23] = itemAt(bytes, 23) ^ 1;
    tampered.files[path] = bytes;
    await expect(importProjectArchive(pack(tampered))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const wrongSize = await archiveObject();
    wrongSize.manifest.screenshots[0].size += 1;
    await expect(importProjectArchive(pack(wrongSize))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const svg = await archiveObject();
    svg.manifest.screenshots[0].mediaType = 'image/svg+xml';
    await expect(importProjectArchive(pack(svg))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const missingFile = await archiveObject();
    missingFile.files = {};
    await expect(importProjectArchive(pack(missingFile))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    const unused = await archiveObject();
    delete unused.manifest.steps[0].screenshotId;
    await expect(importProjectArchive(pack(unused))).rejects.toMatchObject({ code: 'INVALID_BLOB' });

    await expect(
      exportProjectArchive([makeStep({ screenshotBlob: new Blob([await pngBlob().arrayBuffer()], { type: 'image/jpeg' }) })]),
    ).rejects.toMatchObject({ code: 'INVALID_BLOB' });
    await expect(
      exportProjectArchive([makeStep({ screenshotBlob: pngBlob(16_384, 16_384) })]),
    ).rejects.toMatchObject({ code: 'INVALID_BLOB' });
  });

  it('rejects files the manifest does not list and compressed entries', async () => {
    const extra = await archiveObject();
    extra.files['screenshots/payload.html'] = strToU8('<script>alert(1)</script>');
    await expect(importProjectArchive(pack(extra))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const compressed = await archiveObject();
    await expect(importProjectArchive(pack(compressed, 6))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('enforces count, string, and schema bounds', async () => {
    const tooMany = Array.from({ length: PROJECT_ARCHIVE_LIMITS.maxSteps + 1 }, (_, index) =>
      makeStep({ id: `step-${index}`, screenshotBlob: undefined }),
    );
    await expect(exportProjectArchive(tooMany)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    await expect(
      exportProjectArchive([
        makeStep({ description: 'x'.repeat(PERSISTED_STEP_LIMITS.maxStepDescriptionLength + 1) }),
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
    await expect(exportProjectArchive([makeStep({ description: 'bad\u0000text' })])).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });

    const unknownField = await archiveObject();
    unknownField.manifest.steps[0].html = '<script>alert(1)</script>';
    await expect(importProjectArchive(pack(unknownField))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });

    const unknownManifestField = await archiveObject();
    unknownManifestField.manifest.blobs = [];
    await expect(importProjectArchive(pack(unknownManifestField))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('supports AbortSignal before and during Blob reads', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(exportProjectArchive([makeStep()], { signal: alreadyAborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const duringRead = new AbortController();
    class AbortingBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        duringRead.abort();
        return super.arrayBuffer();
      }
    }
    await expect(
      exportProjectArchive([
        makeStep({ screenshotBlob: new AbortingBlob([await pngBlob().arrayBuffer()], { type: 'image/png' }) }),
      ], { signal: duringRead.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const importAbort = new AbortController();
    const valid = await exportProjectArchive([makeStep()]);
    class AbortingArchiveBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        importAbort.abort();
        return super.arrayBuffer();
      }
    }
    await expect(
      importProjectArchive(new AbortingArchiveBlob([valid]), { signal: importAbort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  describe('image edits', () => {
    const edits = [
      { id: 'text-1', kind: 'text' as const, bounds: { x: 10, y: 20, width: 200, height: 31.2 }, text: '點這裡\nClick here', fontSize: 24, look: 'plain' as const, color: '#2f6fed' },
      { id: 'arrow-1', kind: 'arrow' as const, from: { x: 5, y: 6 }, to: { x: 80, y: 90 }, width: 4, color: '#ff4747' },
      { id: 'rect-1', kind: 'rect' as const, bounds: { x: 1, y: 2, width: 30, height: 40 }, width: 2, fill: 'none' as const, color: '#ffc800' },
      { id: 'ellipse-1', kind: 'ellipse' as const, bounds: { x: 3, y: 4, width: 30, height: 20 }, width: 4, fill: 'tint' as const, color: '#22a559' },
      { id: 'step-1', kind: 'step' as const, center: { x: 12, y: 14 }, radius: 16, number: 3, color: '#a1b2c3' },
    ];

    it('round-trips text, arrows, boxes, ellipses and numbered markers on the image owner', async () => {
      const step = makeStep({ id: 'drawn', screenshotBlob: pngBlob(4, 4), imageEdits: edits });
      const { steps } = await importProjectArchive(await exportProjectArchive([step]));
      expect(itemAt(steps, 0).imageEdits).toEqual(edits);
    });

    it('round-trips a crop and rejects a malformed one', async () => {
      const crop = { x: 5, y: 6, width: 70, height: 40 };
      const { steps } = await importProjectArchive(await exportProjectArchive([makeStep({ id: 'cropped', screenshotBlob: pngBlob(4, 4), crop })]));
      expect(itemAt(steps, 0).crop).toEqual(crop);

      const archive = await archiveObject([makeStep({ id: 'cropped', screenshotBlob: pngBlob(4, 4), crop })]);
      archive.manifest.steps[0].crop = { x: 0, y: 0, width: 0, height: 5 };
      await expect(importProjectArchive(pack(archive))).rejects.toBeInstanceOf(ProjectArchiveError);
    });

    it.each([
      ['an unknown colour', { ...edits[2], color: 'chartreuse' }],
      ['an unknown kind', { ...edits[2], kind: 'circle' }],
      ['an unknown field', { ...edits[2], extra: true }],
      ['an empty text', { ...edits[0], text: '' }],
      ['a huge font size', { ...edits[0], fontSize: 5_000 }],
      ['a non-finite arrow point', { ...edits[1], to: { x: 'far', y: 1 } }],
      ['an arrow with bounds fields', { ...edits[1], bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    ])('rejects %s', async (_name, bad) => {
      const archive = await archiveObject([makeStep({ id: 'drawn', screenshotBlob: pngBlob(4, 4), imageEdits: [itemAt(edits, 2)] })]);
      archive.manifest.steps[0].imageEdits = [bad];
      await expect(importProjectArchive(pack(archive))).rejects.toBeInstanceOf(ProjectArchiveError);
    });

    it('rejects duplicate ids and too many edits', async () => {
      const archive = await archiveObject([makeStep({ id: 'drawn', screenshotBlob: pngBlob(4, 4), imageEdits: [itemAt(edits, 2)] })]);
      archive.manifest.steps[0].imageEdits = [edits[2], edits[2]];
      await expect(importProjectArchive(pack(archive))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });

      archive.manifest.steps[0].imageEdits = Array.from(
        { length: PROJECT_ARCHIVE_LIMITS.maxImageEditsPerStep + 1 },
        (_, index) => ({ ...edits[2], id: `r-${index}` }),
      );
      await expect(importProjectArchive(pack(archive))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    });
  });
});
