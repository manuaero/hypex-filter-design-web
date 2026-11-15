import { describe, expect, it, vi } from 'vitest';
import { newProject, type HfdProjectCalibration } from '../src/domain/model';
import { parseHfdCalibration } from '../src/domain/hfd-calibration';
import { createWorkspaceStore } from '../src/state/workspace';
import type { TransferJson } from '../src/application/file-transfers';
import {
  assertWorkspaceWrite,
  type WorkspaceEnvelope,
  type WorkspacePersistenceBackend,
} from '../src/state/persistence';

const principal = { owner: 'site:alice', scope: 'browser-a' };
const raw = '10 6\n1000 6\n';
const microphone: HfdProjectCalibration = {
  filename: 'mic.txt',
  loaded: true,
  showCurve: false,
  resource: { content: raw, curve: parseHfdCalibration(raw, 'mic.txt') },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function envelope(name = 'Initial'): WorkspaceEnvelope {
  return {
    version: 1,
    state: {
      documents: { left: newProject(name), right: newProject('Right') },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
      documentRevision: 0,
    },
  };
}
function memory(initial: unknown | null = null) {
  let stored = structuredClone(initial),
    tail: Promise<unknown> = Promise.resolve();
  let failWrite = false,
    readFailures = 0,
    writeGate: Promise<void> | undefined;
  const history: WorkspaceEnvelope[] = [];
  const backend: WorkspacePersistenceBackend = {
    read: async () => {
      if (readFailures > 0) {
        readFailures--;
        throw Error('Readback unavailable');
      }
      return structuredClone(stored);
    },
    readLegacy: () => null,
    write(next, expected) {
      const job = tail.then(async () => {
        const gate = writeGate;
        writeGate = undefined;
        if (gate) await gate;
        if (failWrite) throw Error('Quota exceeded');
        assertWorkspaceWrite(stored, expected, next);
        stored = structuredClone(next);
        history.push(structuredClone(next));
      });
      tail = job.then(
        () => {},
        () => {},
      );
      return job;
    },
  };
  return {
    backend,
    history,
    get stored() {
      return stored as WorkspaceEnvelope | null;
    },
    set failWrite(value: boolean) {
      failWrite = value;
    },
    set readFailures(value: number) {
      readFailures = value;
    },
    hold(promise: Promise<void>) {
      writeGate = promise;
    },
  };
}
async function fixture(initial?: WorkspaceEnvelope) {
  const disk = memory(initial ?? null),
    workspace = createWorkspaceStore(disk.backend);
  await workspace.persistence.hydrate();
  return { disk, ...workspace };
}

describe('durable single-use file imports', () => {
  it('saves both destinations, remembered calibration and the receipt in one envelope before ACK', async () => {
    const f = await fixture(),
      gate = deferred();
    f.disk.hold(gate.promise);
    let acknowledged = false;
    const committing = f.store
      .getState()
      .commitFileImport(
        'import-1',
        principal,
        0,
        ['left', 'right'],
        (project) => {
          project.name = 'Imported';
          project.hfdCalibration = structuredClone(microphone);
        },
        { ok: true },
        (docs) => docs.left.hfdCalibration,
      )
      .then((value) => {
        acknowledged = true;
        return value;
      });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(f.disk.stored).toBeNull();
    gate.resolve();
    const receipt = await committing;
    expect(receipt).toMatchObject({
      commitId: 'import-1',
      owner: principal.owner,
      scope: principal.scope,
      revision: 1,
      result: { ok: true },
    });
    expect(f.disk.history).toHaveLength(1);
    const durable = f.disk.history[0].state;
    expect(durable.documents.left.name).toBe('Imported');
    expect(durable.documents.right.name).toBe('Imported');
    expect(durable.rememberedHfdCalibration).toEqual(microphone);
    expect(durable.fileCommitReceipts?.['import-1']).toEqual(receipt);
  });

  it('deduplicates concurrent/reloaded retries and retains the receipt after Undo', async () => {
    const f = await fixture();
    let applications = 0;
    const apply = (project: ReturnType<typeof newProject>) => {
      applications++;
      project.name = 'Imported';
    };
    const a = f.store
      .getState()
      .commitFileImport('stable', principal, 0, ['left'], apply, { ok: true });
    const b = f.store
      .getState()
      .commitFileImport('stable', principal, 0, ['left'], apply, { ok: true });
    const receipt = await a;
    expect(await b).toEqual(receipt);
    expect(applications).toBe(1);
    f.store.getState().undo();
    await f.persistence.flush();
    const undone = f.store.getState().documents.left.name;
    expect(undone).not.toBe('Imported');
    expect(
      await f.store
        .getState()
        .commitFileImport('stable', { ...principal, scope: 'new-browser' }, 0, ['left'], apply, {
          ok: false,
        }),
    ).toEqual(receipt);
    expect(f.store.getState().documents.left.name).toBe(undone);
    expect(applications).toBe(1);
    const reload = createWorkspaceStore(f.disk.backend);
    await reload.persistence.hydrate();
    expect(await reload.store.getState().lookupFileCommit('stable', principal.owner)).toEqual(
      receipt,
    );
    expect(await reload.store.getState().lookupFileCommit('stable', 'site:bob')).toBeUndefined();
    await expect(
      reload.store
        .getState()
        .commitFileImport('stable', { owner: 'site:bob', scope: 'b' }, 0, ['right'], apply, {}),
    ).rejects.toThrow('another owner');
    expect(applications).toBe(1);
  });

  it('rejects stale revisions before applying and keeps revisions monotonic across Undo/Redo/cancel', async () => {
    const f = await fixture(),
      revision = () => f.store.getState().documentRevision!;
    f.store.getState().choose({ channel: 1 });
    expect(revision()).toBe(0);
    f.store.getState().editAt(['left'], (p) => {
      p.name = 'A';
    });
    expect(revision()).toBe(1);
    f.store.getState().replace(newProject('B'));
    expect(revision()).toBe(2);
    f.store.getState().undo();
    expect(revision()).toBe(3);
    f.store.getState().redo();
    expect(revision()).toBe(4);
    f.store.getState().beginGesture();
    f.store.getState().editAt(['left'], (p) => {
      p.name = 'Drag1';
    });
    f.store.getState().editAt(['left'], (p) => {
      p.name = 'Drag2';
    });
    expect(revision()).toBe(6);
    f.store.getState().endGesture(true);
    expect(revision()).toBe(7);
    expect(f.store.getState().documents.left.name).toBe('B');
    const apply = vi.fn();
    await expect(
      f.store.getState().commitFileImport('stale', principal, 0, ['left'], apply, {}),
    ).rejects.toThrow('design changed');
    expect(apply).not.toHaveBeenCalled();
    await f.persistence.flush();
    expect(f.disk.stored?.state.documentRevision).toBe(7);
  });

  it('does not publish either destination when a paired apply or resulting project validation fails', async () => {
    const f = await fixture(),
      before = structuredClone(f.store.getState().documents);
    let calls = 0;
    await expect(
      f.store.getState().commitFileImport(
        'paired',
        principal,
        0,
        ['left', 'right'],
        (p) => {
          p.name = 'Changed';
          if (++calls === 2) throw Error('Second destination failed');
        },
        {},
      ),
    ).rejects.toThrow('Second destination');
    expect(f.store.getState().documents).toEqual(before);
    expect(f.store.getState().documentRevision).toBe(0);
    expect(f.disk.history).toHaveLength(0);
    await expect(
      f.store.getState().commitFileImport(
        'invalid-project',
        principal,
        0,
        ['left', 'right'],
        (p) => {
          p.model = 'FA123' as typeof p.model;
        },
        {},
      ),
    ).rejects.toThrow();
    expect(f.store.getState().documents).toEqual(before);
    expect(f.store.getState().fileCommitReceipts).toBeUndefined();
    expect(f.disk.history).toHaveLength(0);
  });

  it('does not ACK failed saves and recovers the same receipt after an explicit persistence retry', async () => {
    const f = await fixture();
    let calls = 0;
    f.disk.failWrite = true;
    await expect(
      f.store.getState().commitFileImport(
        'retry',
        principal,
        0,
        ['left'],
        (p) => {
          calls++;
          p.name = 'Pending import';
        },
        { ok: true },
      ),
    ).rejects.toThrow('Quota exceeded');
    expect(f.disk.stored).toBeNull();
    expect(f.persistence.getSnapshot()).toMatchObject({ unsaved: true, phase: 'error' });
    await expect(f.store.getState().lookupFileCommit('retry', principal.owner)).rejects.toThrow();
    f.disk.failWrite = false;
    await f.persistence.retry();
    const receipt = await f.store.getState().lookupFileCommit('retry', principal.owner);
    expect(receipt?.revision).toBe(1);
    expect(
      await f.store.getState().commitFileImport(
        'retry',
        principal,
        0,
        ['left'],
        () => {
          throw Error('Do not reapply');
        },
        {},
      ),
    ).toEqual(receipt);
    expect(calls).toBe(1);
  });

  it('withholds ACK on readback failure, retries against the acknowledged disk snapshot, and supports reload recovery', async () => {
    const f = await fixture();
    f.disk.readFailures = 1;
    await expect(
      f.store.getState().commitFileImport(
        'readback',
        principal,
        0,
        ['left'],
        (p) => {
          p.name = 'Durable but unverified';
        },
        { ok: true },
      ),
    ).rejects.toThrow('Readback unavailable');
    expect(f.disk.stored?.state.fileCommitReceipts?.readback).toBeDefined();
    const reload = createWorkspaceStore(f.disk.backend);
    await reload.persistence.hydrate();
    expect(
      (await reload.store.getState().lookupFileCommit('readback', principal.owner))?.result,
    ).toEqual({ ok: true });
    await f.persistence.retry();
    expect(f.persistence.getSnapshot()).toMatchObject({ unsaved: false, phase: 'ready' });
    expect(f.disk.stored?.state.documents.left.name).toBe('Durable but unverified');
  });

  it('validates receipt JSON and UTF-8 byte budget before running apply', async () => {
    const f = await fixture();
    const invalidResults: TransferJson[] = [{ bad: Infinity }, { text: 'é'.repeat(40000) }];
    for (const result of invalidResults) {
      const apply = vi.fn();
      await expect(
        f.store
          .getState()
          .commitFileImport('invalid-receipt', principal, 0, ['left'], apply, result),
      ).rejects.toThrow();
      expect(apply).not.toHaveBeenCalled();
      expect(f.store.getState().documentRevision).toBe(0);
      expect(f.store.getState().fileCommitReceipts).toBeUndefined();
    }
  });

  it('stores prototype-looking commit identifiers as own durable keys or rejects them before apply', async () => {
    const f = await fixture();
    let applied = false;
    try {
      const receipt = await f.store.getState().commitFileImport(
        '__proto__',
        principal,
        0,
        ['left'],
        (p) => {
          applied = true;
          p.name = 'Safe key';
        },
        {},
      );
      expect(Object.hasOwn(f.disk.stored!.state.fileCommitReceipts!, '__proto__')).toBe(true);
      expect(await f.store.getState().lookupFileCommit('__proto__', principal.owner)).toEqual(
        receipt,
      );
    } catch (error) {
      expect(applied).toBe(false);
      expect(String(error)).toMatch(/identifier|key/i);
    }
  });
});

describe('workspace snapshot compare-and-swap', () => {
  it('accepts a matching expected snapshot and an identical-write retry, rejecting stale or invalid data', () => {
    const current = envelope(),
      next = structuredClone(current);
    next.state.documentRevision = 1;
    next.state.documents.left.name = 'Next';
    expect(() => assertWorkspaceWrite(current, current, next)).not.toThrow();
    expect(() => assertWorkspaceWrite(next, current, next)).not.toThrow();
    const other = structuredClone(current);
    other.state.documents.right.name = 'Other tab';
    expect(() => assertWorkspaceWrite(other, current, next)).toThrow('another tab');
    expect(() => assertWorkspaceWrite({ version: 99 }, current, next)).toThrow();
    const invalid = structuredClone(next);
    invalid.state.documents.left.model = 'FA123' as typeof invalid.state.documents.left.model;
    expect(() => assertWorkspaceWrite(current, current, invalid)).toThrow();
  });

  it('prevents a stale second controller from overwriting another tab’s document and receipt', async () => {
    const disk = memory(envelope()),
      a = createWorkspaceStore(disk.backend),
      b = createWorkspaceStore(disk.backend);
    await Promise.all([a.persistence.hydrate(), b.persistence.hydrate()]);
    const receipt = await a.store.getState().commitFileImport(
      'winner',
      principal,
      0,
      ['left'],
      (p) => {
        p.name = 'Winner';
      },
      {},
    );
    b.store.getState().editAt(['right'], (p) => {
      p.name = 'Stale write';
    });
    await expect(b.persistence.flush()).rejects.toThrow('another tab');
    expect(disk.stored?.state.documents.left.name).toBe('Winner');
    expect(disk.stored?.state.documents.right.name).toBe('Right');
    expect(disk.stored?.state.fileCommitReceipts?.winner).toEqual(receipt);
    expect(b.persistence.getSnapshot()).toMatchObject({ unsaved: true, phase: 'error' });
  });
});
