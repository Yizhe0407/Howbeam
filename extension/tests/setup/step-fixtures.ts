import { requireProject, runProjectWrite } from '@/lib/storage/database';
import { commitEntries, readEntries } from '@/lib/storage/entry-store';
import { orderedSessionSteps, stepRole, type ScreenshotStep, type Step, type StepEntry } from '@/lib/storage/models';
import { ensureProject } from '@/lib/storage/project-repository';

/** Stores rows as the entries they form, in their order after the Project's
 * existing entries, creating the Project if needed: test data, not a capture,
 * so screenshots are not checked. A snapshot base image stays pending until a
 * row annotates it, here or in a later call, as a recording leaves it. */
export async function seedSteps(steps: readonly Step[]): Promise<void> {
  const [first] = steps;
  if (!first) return;
  const { sessionId, timestamp } = first;
  await ensureProject(sessionId, timestamp);
  await runProjectWrite(async (tx) => {
    const project = await requireProject(tx, sessionId);
    const previous = await readEntries(tx, sessionId);
    const next = [...previous];
    const pending = new Map<string, Step>();
    for (const step of orderedSessionSteps(steps)) {
      const role = stepRole(step);
      if (role === 'ordinary') {
        next.push({ kind: 'single', step: step as ScreenshotStep });
      } else if (role === 'anchor') {
        pending.set(step.id, step);
      } else {
        const index = next.findIndex((entry) => entry.kind === 'group' && entry.anchor.id === step.groupId);
        const group = next[index];
        if (group?.kind === 'group') {
          next[index] = { ...group, annotations: [...group.annotations, step] };
          continue;
        }
        const anchor = pending.get(step.groupId!) ?? (await tx.objectStore('pendingAnchors').get(step.groupId!))?.step;
        if (!anchor) throw new Error(`seedSteps: snapshot ${step.groupId} is unknown.`);
        pending.delete(anchor.id);
        await tx.objectStore('pendingAnchors').delete(anchor.id);
        next.push({ kind: 'group', anchor: anchor as ScreenshotStep, annotations: [step] } satisfies StepEntry);
      }
    }
    if (next.length !== previous.length || next.some((entry, index) => entry !== previous[index])) {
      await commitEntries(tx, project, previous, next);
    }
    for (const step of pending.values()) {
      await tx.objectStore('pendingAnchors').put({ id: step.id, projectId: sessionId, step });
    }
  });
}
