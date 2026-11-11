import { describe, expect, it, vi } from 'vitest';
import { abortable, createRunActor, isSuperseded, type RunStore } from '@/lib/recording/run/actor';
import { toRecordingState, type RunState } from '@/lib/recording/run/state';
import { makeRecordingState } from '../../setup/recording-state';

function memoryStore(initial = makeRecordingState()) {
  const saved: ReturnType<typeof makeRecordingState>[] = [];
  const store: RunStore = {
    load: vi.fn(async () => initial),
    save: vi.fn(async (state) => {
      saved.push(state);
    }),
  };
  return { store, saved };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const withSession = (sessionId: string) => (current: RunState): RunState => ({
  ...current,
  operation: { ...current.operation, sessionId } as RunState['operation'],
});

describe('run actor', () => {
  it('reads the stored state once, before the first operation', async () => {
    const { store } = memoryStore(makeRecordingState({ sessionId: 'project-1' }));
    const actor = createRunActor(store);
    const seen = await actor.run(async (ctx) => ctx.state().operation);
    expect(seen).toMatchObject({ kind: 'idle', sessionId: 'project-1' });
    await actor.run(async () => undefined);
    expect(store.load).toHaveBeenCalledOnce();
  });

  it('writes every commit through to the store, in order', async () => {
    const { store, saved } = memoryStore();
    const actor = createRunActor(store);
    await actor.run(async (ctx) => {
      await ctx.commit(withSession('a'));
      await ctx.commit(withSession('b'));
    });
    expect(saved.map((state) => state.sessionId)).toEqual(['a', 'b']);
    expect(toRecordingState(actor.state())).toEqual(saved.at(-1));
  });

  it('runs operations one at a time, in the order they were queued', async () => {
    const actor = createRunActor(memoryStore().store);
    const gate = deferred();
    const order: string[] = [];
    const first = actor.run(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = actor.run(async () => {
      order.push('second');
    });
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('supersedes the operation in flight at its next await, and the ones queued behind it', async () => {
    const { store, saved } = memoryStore();
    const actor = createRunActor(store);
    const never = new Promise<void>(() => {});
    const inFlight = actor.run(async (ctx) => {
      await ctx.until(never);
      await ctx.commit(withSession('stale'));
    });
    const queued = actor.run(async (ctx) => ctx.commit(withSession('also stale')));
    await actor.ready();

    actor.claim();
    const control = actor.run(async (ctx) => ctx.commit(withSession('control')));

    await expect(inFlight).rejects.toSatisfy(isSuperseded);
    await expect(queued).rejects.toSatisfy(isSuperseded);
    await control;
    expect(saved.map((state) => state.sessionId)).toEqual(['control']);
  });

  it('keeps an operation queued after the claim', async () => {
    const actor = createRunActor(memoryStore().store);
    actor.claim();
    await expect(actor.run(async (ctx) => ctx.commit(withSession('after')))).resolves.toBeTruthy();
  });

  it('starts idle when the stored state cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const actor = createRunActor({ load: async () => { throw new Error('boom'); }, save: async () => {} });
    await expect(actor.run(async (ctx) => ctx.state().operation.kind)).resolves.toBe('idle');
  });
});

describe('abortable', () => {
  it('passes a result through, and rejects when aborted first', async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(3), controller.signal)).resolves.toBe(3);
    const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toSatisfy(isSuperseded);
  });
});
