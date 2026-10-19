import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { addStepsAfter, deleteStep, deleteStepsForRun, getSteps, replaceStepCaptureAtomically, saveStepDescription, StepNotFoundError, updateStepsAtomically } from '@/lib/storage/step-repository';
import { buildStepEntries, getEffectiveBounds, getOrderedAnnotations, STEP_STORAGE_LIMITS, StepStorageValidationError, type Step } from '@/lib/storage/models';
import { closeDatabase, ProjectNotFoundError, summarizeSteps } from '@/lib/storage/database';
import { PROJECT_TAG_LIMITS } from '@/lib/storage/project-tag-model';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { jpegBlob, pngBlob } from '../setup/raster-fixtures';
import { seedSteps } from '../setup/step-fixtures';
import { createProject, createProjectFromSteps, deleteProjectPermanently, duplicateProject, ensureProject, getProject, getProjectSummaries, ProjectTagLimitError, resetProject, updateProject } from '@/lib/storage/project-repository';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    order: 0,
    screenshotBlob: jpegBlob(),
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.com',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function addStep(step: Step): Promise<void> {
  await seedSteps([step]);
}

/** Stores a step through the capture write, the path user data takes. */
async function captureStep(step: Step): Promise<void> {
  await ensureProject(step.sessionId, step.timestamp);
  await addStepsAfter([step], null);
}

describe('buildStepEntries', () => {
  it('groups in linear input order and excludes corrupt annotations', () => {
    const groupId = crypto.randomUUID();
    const anchor = makeStep({ id: groupId, groupId, bounds: null, order: 0 });
    const annotation = makeStep({ groupId, screenshotBlob: undefined, order: 1 });
    const corrupt = makeStep({ groupId, screenshotBlob: undefined, bounds: null, order: 2 });
    const ordinary = makeStep({ order: 3 });

    const entries = buildStepEntries([anchor, annotation, corrupt, ordinary]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'group', anchor: { id: groupId } });
    expect(entries[0].kind === 'group' && entries[0].annotations).toEqual([annotation]);
    expect(entries[1]).toMatchObject({ kind: 'single', step: { id: ordinary.id } });
  });

  it('does not render an empty snapshot anchor as a phantom annotated entry', () => {
    const groupId = crypto.randomUUID();
    const anchor = makeStep({ id: groupId, groupId, bounds: null, order: 0 });

    expect(buildStepEntries([anchor])).toEqual([]);
  });
});

describe('effective visual data', () => {
  it('prefers a valid manual override and can restore the detected bounds', () => {
    const step = makeStep({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      manualBounds: { x: 10, y: 20, width: 30, height: 40 },
    });
    expect(getEffectiveBounds(step)).toEqual(step.manualBounds);
    expect(getEffectiveBounds({ ...step, manualBounds: null })).toEqual(step.bounds);
  });

  it('uses manual bounds when building snapshot annotation order', () => {
    const step = makeStep({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      manualBounds: { x: 9, y: 8, width: 7, height: 6 },
    });
    expect(getOrderedAnnotations([step])).toEqual([{ bounds: step.manualBounds, order: 1 }]);
  });
});

describe('getOrderedAnnotations', () => {
  it('centralizes contiguous display ordering and ignores invalid rows', () => {
    const first = makeStep({ bounds: { x: 1, y: 2, width: 3, height: 4 } });
    const invalid = makeStep({ bounds: null });
    const nonFinite = makeStep({ bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } });
    const empty = makeStep({ bounds: { x: 0, y: 0, width: 0, height: 10 } });
    const second = makeStep({ bounds: { x: 5, y: 6, width: 7, height: 8 } });

    expect(getOrderedAnnotations([first, invalid, nonFinite, empty, second])).toEqual([
      { bounds: first.bounds, order: 1 },
      { bounds: second.bounds, order: 2 },
    ]);
  });
});

describe('step storage boundaries', () => {
  it('stores a canonical record and strips unknown properties and control characters', async () => {
    const step = makeStep({ description: 'safe\u0000 text' }) as Step & { attackerPayload?: string };
    step.attackerPayload = 'must not persist';
    await addStep(step);

    const stored = (await getSteps(step.sessionId))[0] as Step & { attackerPayload?: string };
    expect(stored.description).toBe('safe text');
    expect(stored.attackerPayload).toBeUndefined();
  });

  it.each([
    ['id', { id: ' bad-id' }],
    ['session id', { sessionId: `project-${'x'.repeat(STEP_STORAGE_LIMITS.maxIdLength)}` }],
    ['run id', { runId: 'run\npoison' }],
    ['group id', { groupId: '' }],
  ])('rejects an invalid %s before writing', async (_label, overrides) => {
    const step = makeStep(overrides as Partial<Step>);
    await expect(captureStep(step)).rejects.toBeInstanceOf(StepStorageValidationError);
  });

  it.each([
    { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { devicePixelRatio: 0 },
    { screenshotScale: STEP_STORAGE_LIMITS.maxPixelRatio + 1 },
    { captureRevision: -1 },
  ])('rejects invalid numeric metadata: %j', async (overrides) => {
    await expect(captureStep(makeStep(overrides))).rejects.toBeInstanceOf(StepStorageValidationError);
  });

  it('nulls impossible capture bounds and privacy-gates impossible redaction bounds', async () => {
    const step = makeStep({
      bounds: { x: STEP_STORAGE_LIMITS.maxCoordinateMagnitude, y: 0, width: 2, height: 2 },
      manualBounds: { x: 0, y: 0, width: STEP_STORAGE_LIMITS.maxBoundsDimension + 1, height: 2 },
      redactions: [{
        id: 'mask',
        kind: 'solid',
        bounds: { x: 0, y: 0, width: 2, height: STEP_STORAGE_LIMITS.maxBoundsDimension + 1 },
      }],
    });
    await addStep(step);

    expect((await getSteps(step.sessionId))[0]).toMatchObject({
      bounds: null,
      manualBounds: null,
      redactions: [],
      redactionReviewRequired: true,
    });
  });

  it('rejects descriptions that cannot be represented in project backups', async () => {
    await expect(captureStep(makeStep({
      description: 'x'.repeat(STEP_STORAGE_LIMITS.maxStepDescriptionLength + 1),
    }))).rejects.toBeInstanceOf(StepStorageValidationError);
  });

  it('holds an annotation description to the shorter annotation limit', async () => {
    const description = 'x'.repeat(STEP_STORAGE_LIMITS.maxAnnotationDescriptionLength + 1);
    await expect(captureStep(makeStep({ groupId: 'anchor-1', screenshotBlob: undefined, description })))
      .rejects.toBeInstanceOf(StepStorageValidationError);
    await expect(captureStep(makeStep({ description }))).resolves.toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'https://user:secret@example.com/private', 'x'.repeat(STEP_STORAGE_LIMITS.maxUrlLength + 1)])(
    'rejects unsafe or oversized persisted URLs',
    async (url) => {
      await expect(captureStep(makeStep({ url }))).rejects.toBeInstanceOf(StepStorageValidationError);
    },
  );

  it('rejects a screenshot above the per-image storage budget', async () => {
    await expect(captureStep(makeStep({
      screenshotBlob: pngBlob(2, 2, STEP_STORAGE_LIMITS.maxScreenshotBytes + 1 - 24),
    }))).rejects.toBeInstanceOf(StepStorageValidationError);
  });

  it('rejects excessive redactions and privacy-gates duplicate identifiers', async () => {
    const bounds = { x: 1, y: 1, width: 2, height: 2 };
    await expect(captureStep(makeStep({
      redactions: Array.from({ length: STEP_STORAGE_LIMITS.maxRedactionsPerStep + 1 }, (_, index) => ({
        id: `mask-${index}`,
        kind: 'solid' as const,
        bounds,
      })),
    }))).rejects.toBeInstanceOf(StepStorageValidationError);

    const duplicate = makeStep({
      redactions: [
        { id: 'mask', kind: 'solid', bounds },
        { id: 'mask', kind: 'solid', bounds: { x: 3, y: 3, width: 2, height: 2 } },
      ],
    });
    await addStep(duplicate);
    expect((await getSteps(duplicate.sessionId))[0]).toMatchObject({
      redactions: [{ id: 'mask', kind: 'solid', bounds }],
      redactionReviewRequired: true,
    });
  });

  it('rejects projects above the durable step and aggregate screenshot budgets', async () => {
    const sessionId = crypto.randomUUID();
    const tinyBlob = pngBlob();
    const tooMany = Array.from({ length: STEP_STORAGE_LIMITS.maxStepsPerProject + 1 }, (_, order) => makeStep({
      id: `step-${order}`,
      sessionId,
      order,
      screenshotBlob: tinyBlob,
    }));
    await expect(createProjectFromSteps(tooMany)).rejects.toBeInstanceOf(StepStorageValidationError);

    const largeBlob = pngBlob(2, 2, STEP_STORAGE_LIMITS.maxScreenshotBytes - 24);
    const tooLarge = Array.from({ length: 5 }, (_, order) => makeStep({
      id: `large-${order}`,
      sessionId: crypto.randomUUID(),
      order,
      screenshotBlob: largeBlob,
    }));
    await expect(createProjectFromSteps(tooLarge)).rejects.toBeInstanceOf(StepStorageValidationError);
  });

  it('rejects oversized mutation vectors before opening a transaction', async () => {
    await expect(updateStepsAtomically(
      'missing-project',
      Array.from({ length: STEP_STORAGE_LIMITS.maxMutationItems + 1 }, (_, index) => ({ id: `step-${index}`, changes: {} })),
    )).rejects.toBeInstanceOf(StepStorageValidationError);
  });
});

describe('step persistence', () => {
  it('keeps the summary equal to a recount of the rows after every write that rereads them', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    const recount = async () => {
      const project = await getProject(sessionId);
      expect({
        stepCount: project?.stepCount,
        entryCount: project?.entryCount,
        storageBytes: project?.storageBytes,
      }).toEqual(summarizeSteps(await getSteps(sessionId)));
    };
    const groupId = `${sessionId}-snap`;

    await addStepsAfter([
      makeStep({ id: `${sessionId}-a`, sessionId, runId: 'run-1' }),
      makeStep({ id: `${sessionId}-b`, sessionId, runId: 'run-1', screenshotBlob: pngBlob() }),
    ], null);
    await recount();
    await addStepsAfter([
      makeStep({ id: groupId, sessionId, runId: 'run-2', groupId, bounds: null }),
      makeStep({ id: `${sessionId}-mark`, sessionId, runId: 'run-2', groupId, screenshotBlob: undefined }),
    ], `${sessionId}-a`);
    await recount();
    await replaceStepCaptureAtomically(
      sessionId,
      { kind: 'snapshot-singleton', anchorId: groupId, annotationId: `${sessionId}-mark` },
      {
        screenshotBlob: pngBlob(40, 40, 500),
        bounds: { x: 1, y: 1, width: 5, height: 5 },
        devicePixelRatio: 1,
        screenshotScale: 1,
        url: 'https://example.com',
        timestamp: 10,
      },
      'recapture-1',
    );
    await recount();
    await deleteStep(`${sessionId}-b`);
    await recount();
    await deleteStepsForRun(sessionId, 'run-2');
    await recount();
    expect((await getProject(sessionId))?.stepCount).toBe(1);
  });

  it('persists a batch in one transaction with a single summary refresh', async () => {
    const sessionId = crypto.randomUUID();
    const project = await ensureProject(sessionId);
    const steps = [0, 1, 2].map((order) => makeStep({ sessionId, order, timestamp: 100 + order }));

    await addStepsAfter(steps, null);

    const persisted = await getSteps(sessionId);
    expect(persisted.map((step) => step.order)).toEqual([0, 1, 2]);
    const updated = await getProject(sessionId);
    expect(updated?.stepCount).toBe(3);
    // One refresh for the whole batch — not one contentRevision per row.
    expect(updated?.contentRevision).toBe(project.contentRevision + 1);
  });

  it('inserts a run after the chosen row and keeps its rows together in capture order', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    const old = [0, 1, 2].map((order) => makeStep({ id: `old-${order}`, sessionId, order, timestamp: 100 + order }));
    await seedSteps(old);
    const runId = 'run-1';

    await addStepsAfter([makeStep({ id: 'new-a', sessionId, runId, order: 3, timestamp: 200 })], 'old-0');
    await addStepsAfter([makeStep({ id: 'new-b', sessionId, runId, order: 4, timestamp: 201 })], 'old-0');

    const persisted = await getSteps(sessionId);
    expect(persisted.map((step) => step.id)).toEqual(['old-0', 'new-a', 'new-b', 'old-1', 'old-2']);
    expect(persisted.map((step) => step.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('appends when no row is named or the named row is gone', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    await seedSteps([makeStep({ id: 'solo-0', sessionId, order: 0 })]);

    await addStepsAfter([makeStep({ id: 'solo-a', sessionId, runId: 'r', order: 1 })], null);
    await addStepsAfter([makeStep({ id: 'solo-b', sessionId, runId: 'r2', order: 2 })], 'missing');

    expect((await getSteps(sessionId)).map((step) => step.id)).toEqual(['solo-0', 'solo-a', 'solo-b']);
  });

  it('assigns order from the rows it reads, never from the caller', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    // Gapped order, as an older build could leave it.
    await seedSteps([
      makeStep({ id: 'gap-0', sessionId, order: 0 }),
      makeStep({ id: 'gap-1', sessionId, order: 4 }),
    ]);

    await addStepsAfter([makeStep({ id: 'gap-a', sessionId, runId: 'run-1', order: 0 })], null);
    await addStepsAfter([makeStep({ id: 'gap-b', sessionId, runId: 'run-1', order: 0 })], null);

    const persisted = await getSteps(sessionId);
    expect(persisted.map((step) => step.id)).toEqual(['gap-0', 'gap-1', 'gap-a', 'gap-b']);
    expect(persisted.map((step) => step.order)).toEqual([0, 1, 2, 3]);
  });

  it('puts an undone row back after its run’s last row', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    await seedSteps([
      makeStep({ id: 'undo-a', sessionId, runId: 'run-1', order: 0 }),
      makeStep({ id: 'undo-later', sessionId, runId: 'run-0', order: 1 }),
    ]);
    const undone = makeStep({ id: 'undo-b', sessionId, runId: 'run-1', order: 7 });

    await addStepsAfter([undone], 'undo-later');

    expect((await getSteps(sessionId)).map((step) => step.id)).toEqual(['undo-a', 'undo-b', 'undo-later']);
  });

  it('rejects a cross-project batch atomically', async () => {
    const sessionId = crypto.randomUUID();
    await ensureProject(sessionId);
    const foreign = makeStep({ order: 1 });

    await expect(addStepsAfter([makeStep({ sessionId, order: 0 }), foreign], null)).rejects.toThrow(
      /belongs to another project/,
    );
    expect(await getSteps(sessionId)).toHaveLength(0);
  });

  it('does not persist duplicate screenshot blobs on snapshot annotations', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    await addStep(makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null }));
    const annotation = makeStep({ sessionId, groupId: anchorId, order: 1 });
    await addStep(annotation);

    const stored = await getSteps(sessionId);

    expect(stored.find((step) => step.id === anchorId)?.screenshotBlob).toBeInstanceOf(Blob);
    expect(stored.find((step) => step.id === annotation.id)?.screenshotBlob).toBeUndefined();
  });

  it('preserves concurrent field updates in one-store transactions', async () => {
    const step = makeStep();
    await addStep(step);

    await Promise.all([
      saveStepDescription(step.id, 'updated', step.description),
      updateStepsAtomically(step.sessionId, [{ id: step.id, changes: { crop: { x: 0, y: 0, width: 1, height: 1 } } }]),
    ]);

    expect((await getSteps(step.sessionId))[0]).toMatchObject({ description: 'updated', crop: { x: 0, y: 0, width: 1, height: 1 } });
  });

  it('discards only the selected recording run and closes remaining order gaps', async () => {
    const sessionId = crypto.randomUUID();
    const previous = makeStep({ sessionId, runId: 'previous-run', order: 0, description: 'keep' });
    const discardedAnchorId = crypto.randomUUID();
    const discardedAnchor = makeStep({
      id: discardedAnchorId,
      sessionId,
      runId: 'discarded-run',
      groupId: discardedAnchorId,
      bounds: null,
      order: 1,
    });
    const discardedAnnotation = makeStep({
      sessionId,
      runId: 'discarded-run',
      groupId: discardedAnchorId,
      screenshotBlob: undefined,
      order: 2,
    });
    const later = makeStep({ sessionId, runId: 'later-run', order: 3, description: 'also keep' });
    await Promise.all([previous, discardedAnchor, discardedAnnotation, later].map(addStep));

    await deleteStepsForRun(sessionId, 'discarded-run');

    expect((await getSteps(sessionId)).map(({ id, order, description }) => ({ id, order, description }))).toEqual([
      { id: previous.id, order: 0, description: 'keep' },
      { id: later.id, order: 1, description: 'also keep' },
    ]);
  });

  it('reports a missing row with a typed error instead of a silent no-op', async () => {
    // An autosave that treats a resolved update as committed would otherwise
    // clear its draft journal even though nothing was written.
    await expect(saveStepDescription(crypto.randomUUID(), '孤兒寫入', ''))
      .rejects.toBeInstanceOf(StepNotFoundError);
  });

  it('saves a description only while the persisted value matches the expected baseline', async () => {
    const step = makeStep({ description: '原始' });
    await addStep(step);

    await saveStepDescription(step.id, '分頁 A 的版本', '原始');
    await expect(saveStepDescription(step.id, '分頁 B 的版本', '原始')).rejects.toMatchObject({
      name: 'StepDescriptionConflictError',
      stepId: step.id,
      actualDescription: '分頁 A 的版本',
    });

    expect((await getSteps(step.sessionId))[0].description).toBe('分頁 A 的版本');
  });

  it('sanitizes malformed manual bounds and redaction records before storage', async () => {
    const step = makeStep({
      manualBounds: { x: 1, y: 2, width: Number.NaN, height: 4 },
      redactions: [
        { id: '   ', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } },
        { id: 'invalid-bounds', kind: 'solid', bounds: { x: 1, y: 1, width: 0, height: 2 } },
        { id: 'valid-mask', kind: 'solid', bounds: { x: 3, y: 4, width: 5, height: 6 } },
      ],
    });

    await addStep(step);

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored.manualBounds).toBeNull();
    expect(stored.redactions).toEqual([
      { id: 'valid-mask', kind: 'solid', bounds: { x: 3, y: 4, width: 5, height: 6 } },
    ]);
    expect(stored.redactionReviewRequired).toBe(true);
  });

});


describe('atomic visual edits and recapture', () => {
  it('stores redactions only on the screenshot owner and preserves concurrent metadata', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null });
    const annotation = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    await Promise.all([addStep(anchor), addStep(annotation)]);

    await Promise.all([
      saveStepDescription(annotation.id, 'new description', annotation.description),
      updateStepsAtomically(sessionId, [
        { id: annotation.id, changes: { redactions: [{ id: 'wrong-owner', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }] } },
        { id: anchor.id, changes: { redactions: [{ id: 'mask', kind: 'solid', bounds: { x: 8, y: 9, width: 10, height: 11 } }] } },
      ]),
    ]);

    const stored = await getSteps(sessionId);
    expect(stored.find((step) => step.id === annotation.id)).toMatchObject({ description: 'new description' });
    expect(stored.find((step) => step.id === annotation.id)?.redactions).toBeUndefined();
    expect(stored.find((step) => step.id === anchor.id)?.redactions?.[0].id).toBe('mask');
  });

  it('recaptures an ordinary step without changing its identity, order, description or provenance', async () => {
    const step = makeStep({ order: 7, description: 'keep', runId: 'original-run', manualBounds: { x: 9, y: 9, width: 9, height: 9 }, redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }] });
    await addStep(step);
    const screenshotBlob = jpegBlob(4, 4);

    await replaceStepCaptureAtomically(step.sessionId, { kind: 'single', stepId: step.id }, {
      screenshotBlob,
      bounds: { x: 20, y: 30, width: 40, height: 50 },
      devicePixelRatio: 2,
      screenshotScale: 1.5,
      url: 'https://example.com/recaptured',
      timestamp: 123,
    }, 'recapture-run');

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored).toMatchObject({
      id: step.id,
      sessionId: step.sessionId,
      order: 7,
      description: 'keep',
      runId: 'original-run',
      bounds: { x: 20, y: 30, width: 40, height: 50 },
      manualBounds: null,
      redactions: [],
      captureRevision: 1,
      lastCaptureRunId: 'recapture-run',
    });
    expect(new Uint8Array(await stored.screenshotBlob!.arrayBuffer())).toEqual(new Uint8Array(await screenshotBlob.arrayBuffer()));
  });


  it('rejects a stale capture-revision update after ordinary recapture and keeps the masks cleared pending review', async () => {
    const step = makeStep({
      redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }],
    });
    await addStep(step);
    await replaceStepCaptureAtomically(
      step.sessionId,
      { kind: 'single', stepId: step.id },
      {
        screenshotBlob: jpegBlob(4, 4),
        bounds: { x: 20, y: 30, width: 40, height: 50 },
        devicePixelRatio: 1,
        screenshotScale: 1,
        url: step.url,
        timestamp: 123,
      },
      'recapture-run',
    );

    await expect(
      updateStepsAtomically(step.sessionId, [
        { id: step.id, changes: { crop: { x: 7, y: 7, width: 7, height: 7 } } },
        {
          id: step.id,
          expectedCaptureRevision: 0,
          changes: { redactions: [], redactionReviewRequired: false },
        },
      ]),
    ).rejects.toMatchObject({ name: 'StepUpdateConflictError' });

    const stored = (await getSteps(step.sessionId))[0];
    expect(stored.captureRevision).toBe(1);
    expect(stored.manualBounds).toBeNull();
    expect(stored.crop).toBeUndefined();
    expect(stored.redactions).toEqual([]);
    // The old masks covered the old pixels: the new image waits for its masks to be checked.
    expect(stored.redactionReviewRequired).toBe(true);
  });

  it('rolls back stale snapshot annotation edits when the anchor revision changed', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({
      id: anchorId,
      sessionId,
      groupId: anchorId,
      bounds: null,
      redactions: [{ id: 'old-mask', kind: 'solid', bounds: { x: 1, y: 1, width: 2, height: 2 } }],
    });
    const annotation = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    await Promise.all([addStep(anchor), addStep(annotation)]);
    await replaceStepCaptureAtomically(
      sessionId,
      { kind: 'snapshot-singleton', anchorId, annotationId: annotation.id },
      {
        screenshotBlob: jpegBlob(4, 4),
        bounds: { x: 20, y: 30, width: 40, height: 50 },
        devicePixelRatio: 1,
        screenshotScale: 1,
        url: anchor.url,
        timestamp: 123,
      },
      'recapture-run',
    );

    await expect(
      updateStepsAtomically(sessionId, [
        { id: anchorId, changes: { crop: { x: 7, y: 7, width: 7, height: 7 } } },
        {
          id: anchorId,
          expectedCaptureRevision: 0,
          changes: { redactions: [], redactionReviewRequired: false },
        },
      ]),
    ).rejects.toMatchObject({ name: 'StepUpdateConflictError' });

    const stored = await getSteps(sessionId);
    const storedAnchor = stored.find((item) => item.id === anchorId)!;
    const storedAnnotation = stored.find((item) => item.id === annotation.id)!;
    expect(storedAnchor.captureRevision).toBe(1);
    expect(storedAnchor.redactions).toEqual([]);
    expect(storedAnchor.redactionReviewRequired).toBe(true);
    expect(storedAnchor.crop).toBeUndefined();
    expect(storedAnnotation.manualBounds).toBeNull();
    expect(storedAnnotation.bounds).toEqual({ x: 20, y: 30, width: 40, height: 50 });
  });

  it('rejects recapturing a snapshot that has multiple annotations without writing', async () => {
    const sessionId = crypto.randomUUID();
    const anchorId = crypto.randomUUID();
    const anchor = makeStep({ id: anchorId, sessionId, groupId: anchorId, bounds: null });
    const first = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 1 });
    const second = makeStep({ sessionId, groupId: anchorId, screenshotBlob: undefined, order: 2 });
    await Promise.all([anchor, first, second].map(addStep));

    await expect(replaceStepCaptureAtomically(sessionId, { kind: 'snapshot-singleton', anchorId, annotationId: first.id }, {
      screenshotBlob: jpegBlob(4, 4),
      bounds: { x: 10, y: 10, width: 10, height: 10 },
      devicePixelRatio: 1,
      screenshotScale: 1,
      url: anchor.url,
      timestamp: 999,
    }, 'recapture-run')).rejects.toMatchObject({ code: 'UNSUPPORTED_SNAPSHOT_GROUP' });

    const kept = (await getSteps(sessionId)).find((step) => step.id === anchorId)!.screenshotBlob!;
    expect(new Uint8Array(await kept.arrayBuffer())).toEqual(new Uint8Array(await jpegBlob().arrayBuffer()));
  });
});


describe('project transaction safety', () => {
  it('allows capture writes to an existing project', async () => {
    const step = makeStep();
    await ensureProject(step.sessionId, step.timestamp);

    await expect(addStepsAfter([step], null)).resolves.toBeUndefined();
    expect(await getSteps(step.sessionId)).toHaveLength(1);
  });

  it('does not resurrect a permanently deleted project from a stale capture write', async () => {
    const step = makeStep();
    await ensureProject(step.sessionId, step.timestamp);
    await addStepsAfter([step], null);
    await deleteProjectPermanently(step.sessionId);

    await expect(addStepsAfter([{ ...step, description: 'stale write' }], null)).rejects.toThrow('Project not found.');
    expect(await getProject(step.sessionId)).toBeUndefined();
    expect(await getSteps(step.sessionId)).toEqual([]);
  });

  it('resets steps, increments content revision once, and zeroes summary metadata atomically', async () => {
    const sessionId = crypto.randomUUID();
    const first = makeStep({ sessionId, order: 0, screenshotBlob: pngBlob() });
    const second = makeStep({ sessionId, order: 1, screenshotBlob: pngBlob() });
    await ensureProject(sessionId);
    await seedSteps([first]);
    await seedSteps([second]);
    const before = (await getProject(sessionId))!;

    const reset = await resetProject(sessionId);

    expect(reset.contentRevision).toBe(before.contentRevision + 1);
    expect(reset).toMatchObject({ stepCount: 0, entryCount: 0, storageBytes: 0 });
    expect(await getSteps(sessionId)).toEqual([]);
    expect(await getProject(sessionId)).toEqual(reset);
  });

  it('serves summaries from project metadata without opening the step index or Blob payload', async () => {
    const sessionId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    await ensureProject(sessionId);
    await seedSteps([makeStep({ sessionId, order: 0, screenshotBlob: pngBlob(2, 2, 5) })]);
    await seedSteps([makeStep({ id: groupId, sessionId, groupId, bounds: null, order: 1, screenshotBlob: pngBlob(2, 2, 6) })]);
    await seedSteps([makeStep({ sessionId, groupId, order: 2, screenshotBlob: undefined })]);

    const nativeGetAll = IDBIndex.prototype.getAll;
    const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      if (this.name === 'by-session') throw new Error('summary attempted to load step rows');
      return nativeGetAll.apply(this, args as Parameters<IDBIndex['getAll']>);
    });
    const blobTextSpy = vi.spyOn(Blob.prototype, 'text');
    const blobArrayBufferSpy = vi.spyOn(Blob.prototype, 'arrayBuffer');
    try {
      const summary = (await getProjectSummaries()).find((project) => project.id === sessionId);
      expect(summary).toMatchObject({ stepCount: 2, entryCount: 2, storageBytes: 59 });
      expect(blobTextSpy).not.toHaveBeenCalled();
      expect(blobArrayBufferSpy).not.toHaveBeenCalled();
    } finally {
      getAllSpy.mockRestore();
      blobTextSpy.mockRestore();
      blobArrayBufferSpy.mockRestore();
    }
  });

  it('rolls back an imported project when a later cloned step violates a key constraint', async () => {
    const destinationId = crypto.randomUUID();
    const duplicateStepId = crypto.randomUUID();
    const source = [makeStep({ id: 'source-a', order: 0 }), makeStep({ id: 'source-b', order: 1 })];
    const uuidSpy = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(destinationId)
      .mockReturnValueOnce(duplicateStepId)
      .mockReturnValueOnce(duplicateStepId);
    try {
      await expect(createProjectFromSteps(source, { title: 'import' })).rejects.toBeTruthy();
    } finally {
      uuidSpy.mockRestore();
    }
    expect(await getProject(destinationId)).toBeUndefined();
    expect(await getSteps(destinationId)).toEqual([]);
  });

  it('rolls back duplicate project metadata if cloning a source step fails', async () => {
    const sourceStep = makeStep();
    await ensureProject(sourceStep.sessionId);
    await seedSteps([sourceStep]);
    const destinationId = crypto.randomUUID();
    const uuidSpy = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(destinationId)
      .mockReturnValueOnce(sourceStep.id as ReturnType<Crypto['randomUUID']>);
    try {
      await expect(duplicateProject(sourceStep.sessionId)).rejects.toBeTruthy();
    } finally {
      uuidSpy.mockRestore();
    }
    expect(await getProject(destinationId)).toBeUndefined();
    expect((await getSteps(sourceStep.sessionId)).map((step) => step.id)).toEqual([sourceStep.id]);
  });
});

describe('stored text and screenshots match the archive rules', () => {
  it('stores C1 controls the way export accepts, and returns the stored description', async () => {
    const step = makeStep({ description: 'a\u0085b\u0007c\vd' });
    await addStep(step);
    expect((await getSteps(step.sessionId))[0].description).toBe('abcd');

    await expect(saveStepDescription(step.id, 'x\u009fy\fz', 'abcd')).resolves.toBe('xyz');
    // The returned value is the CAS baseline: saving against it succeeds.
    await expect(saveStepDescription(step.id, 'next', 'xyz')).resolves.toBe('next');

    await updateProject(step.sessionId, { title: '標題\u0085', description: '說明\u0080' });
    const project = (await getProject(step.sessionId))!;
    expect(project).toMatchObject({ title: '標題', description: '說明' });
    await expect(exportProjectArchive(await getSteps(step.sessionId), {
      metadata: { title: project.title, description: project.description },
    })).resolves.toEqual(expect.any(Blob));
  });

  it.each([
    ['an empty file', new Blob([], { type: 'image/png' })],
    ['a GIF', new Blob(['GIF89a'], { type: 'image/gif' })],
    ['bytes that are not the declared image', new Blob(['not a png at all, only text'], { type: 'image/png' })],
    ['an image beyond the raster dimension limit', pngBlob(16_385, 10)],
  ])('refuses to store %s, which export would reject', async (_label, screenshotBlob) => {
    const step = makeStep({ screenshotBlob });
    await ensureProject(step.sessionId);
    await expect(addStepsAfter([step], null)).rejects.toBeInstanceOf(StepStorageValidationError);
    await expect(createProjectFromSteps([makeStep({ screenshotBlob })])).rejects.toBeInstanceOf(StepStorageValidationError);
    expect(await getSteps(step.sessionId)).toEqual([]);
  });

});

describe('project metadata', () => {
  it('merges tag operations from two stale editors instead of the later list winning', async () => {
    const project = await createProject({ tags: ['共用'] });
    // Both tabs last saw ['共用']; each adds or removes one tag.
    await updateProject(project.id, { addTags: ['分頁 A'] });
    await updateProject(project.id, { addTags: ['分頁 B'] });
    await updateProject(project.id, { removeTags: ['共用'] });
    expect((await getProject(project.id))!.tags).toEqual(['分頁 A', '分頁 B']);
  });

  it('refuses a tag beyond the limit instead of silently dropping it', async () => {
    const tags = Array.from({ length: PROJECT_TAG_LIMITS.maxTags }, (_, index) => `tag-${index}`);
    const project = await createProject({ tags });
    await expect(updateProject(project.id, { addTags: ['one-too-many'] })).rejects.toBeInstanceOf(ProjectTagLimitError);
    expect((await getProject(project.id))!.tags).toEqual(tags);
    // Re-adding an existing tag is a no-op, not a limit violation.
    await expect(updateProject(project.id, { addTags: ['tag-0'] })).resolves.toMatchObject({ tags });
  });

  it('reports a deleted project with a typed error', async () => {
    const project = await createProject();
    await deleteProjectPermanently(project.id);
    await expect(updateProject(project.id, { title: 'gone' })).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

afterAll(async () => {
  await closeDatabase();
});
