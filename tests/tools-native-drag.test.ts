import { expect, it, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type DocumentState,
} from '../src/application/tools';
import { newProject, newFilter, type Slot } from '../src/domain/model';
function fixture() {
  let state: DocumentState = {
    documents: { left: newProject('Left synthetic'), right: newProject('Right synthetic') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: false,
    documentRevision: 4,
  };
  for (const slot of ['left', 'right'] as const) {
    const f = state.documents[slot].presets[0].channels[0].filters[0];
    Object.assign(f, {
      ...newFilter('peak'),
      frequency: 2300,
      frequency2: 988.101806640625,
      q: 1.15,
      gain: slot === 'left' ? 7.5 : -4,
      enabled: slot === 'right',
      coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
      provenance: 'hfd',
    });
  }
  // Deliberately duplicate native identities across independent roles. They must
  // never be used to infer which role receives a planned relative-gain result.
  state.documents.right.presets[0].channels[0].filters[0].id =
    state.documents.left.presets[0].channels[0].filters[0].id;
  const history: (typeof state.documents)[] = [],
    forbidden = vi.fn(() => {
      throw new Error('Unexpected hardware or global operation');
    });
  const editByRole = vi.fn(
    (slots: Slot[], fn: (project: typeof state.documents.left, slot: Slot) => void) => {
      const documents = structuredClone(state.documents);
      slots.forEach((slot) => fn(documents[slot], slot));
      history.push(state.documents);
      state = { ...state, documents, documentRevision: (state.documentRevision ?? 0) + 1 };
    },
  );
  const adapter: ToolAdapter = {
    state: () => state,
    edit: (slots, fn) => editByRole(slots, (project) => fn(project)),
    editByRole,
    choose: (patch) => {
      state = { ...state, ...patch };
    },
    undo: () => {
      const prior = history.pop();
      if (prior) state = { ...state, documents: prior };
    },
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: forbidden,
    progress: forbidden,
    message: vi.fn(),
    view: vi.fn(),
  };
  return {
    adapter,
    execute: createToolExecutor(adapter),
    state: () => state,
    history,
    editByRole,
    forbidden,
  };
}
const position = {
  surface: 'graph-drag',
  target: 'both',
  preset: 1,
  channel: 1,
  index: 1,
  frequency: 6319.00537109375,
  originAxisY: 1,
  axisY: 4.05,
};
it('strict graph-drag schema admits only its complete finite position contract and retains91commands', async () => {
  const f = fixture();
  for (const args of [
    { ...position, parameter: 'gain' },
    { ...position, direction: 'up' },
    { ...position, basis: 'each' },
    { ...position, axisY: undefined },
    { ...position, frequency: Infinity },
    { ...position, frequency: 0 },
    { ...position, frequency: 0.0009 },
    { ...position, frequency: 50000.1 },
    { ...position, originAxisY: NaN },
    { ...position, coefficients: { b0: 1 } },
  ])
    expect(await f.execute('fusion_filter_adjust', args)).toMatchObject({ ok: false });
  expect(f.editByRole).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(TOOL_DEFINITIONS).toHaveLength(92);
});
it('applies one shared absolute frequency and independently captured relative gains to explicit duplicate-ID roles', async () => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  const result = await f.execute('fusion_filter_adjust', position);
  expect(result).toMatchObject({
    ok: true,
    surface: 'graph-drag',
    changed: true,
    roles: [
      { slot: 'left', value: { frequency: 6319.00537109375, gain: 10.55 } },
      { slot: 'right', value: { frequency: 6319.00537109375, gain: -0.95 } },
    ],
  });
  expect(f.state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    enabled: false,
    frequency2: 988.101806640625,
  });
  expect(f.state().documents.right.presets[0].channels[0].filters[0]).toMatchObject({
    enabled: true,
    frequency2: 988.101806640625,
  });
  expect(f.editByRole).toHaveBeenCalledOnce();
  expect(f.history).toHaveLength(1);
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('normalizes a fresh event once per command while preserving inactive destination gain', async () => {
  const f = fixture();
  f.state().documents.right.presets[0].channels[0].filters[0].kind = 'allpass2';
  expect(await f.execute('fusion_filter_adjust', position)).toMatchObject({ ok: true });
  expect(f.state().documents.right.presets[0].channels[0].filters[0].gain).toBe(-4);
  expect(f.state().documents.left.presets[0].channels[0].filters[0].gain).toBe(10.55);
  expect(await f.execute('fusion_filter_adjust', position)).toMatchObject({ ok: true });
  expect(f.state().documents.left.presets[0].channels[0].filters[0].gain).toBe(13.6);
});
it('preflights all paired roles before any edit and refuses linked or unsupported destinations atomically', async () => {
  for (const bad of ['linked', 'raw', 'unity'] as const) {
    const f = fixture();
    const c = f.state().documents.right.presets[0].channels[0];
    if (bad === 'linked') c.linkedTo = 1;
    else c.filters[0].kind = bad;
    const before = structuredClone(f.state().documents);
    expect(await f.execute('fusion_filter_adjust', position)).toMatchObject({ ok: false });
    expect(f.state().documents).toEqual(before);
    expect(f.editByRole).not.toHaveBeenCalled();
    expect(f.history).toHaveLength(0);
  }
});
it('canonical position no-ops preserve imported cache/provenance, revision and Undo history', async () => {
  const f = fixture(),
    before = structuredClone(f.state().documents),
    revision = f.state().documentRevision;
  expect(
    await f.execute('fusion_filter_adjust', { ...position, frequency: 2300, axisY: 1 }),
  ).toMatchObject({ ok: true, changed: false });
  expect(f.state().documents).toEqual(before);
  expect(f.state().documentRevision).toBe(revision);
  expect(f.editByRole).not.toHaveBeenCalled();
  expect(f.history).toHaveLength(0);
});
it('does not infer role from project identity when the client lacks an explicit-role edit port', async () => {
  const f = fixture();
  delete f.adapter.editByRole;
  const execute = createToolExecutor(f.adapter),
    before = structuredClone(f.state().documents);
  expect(await execute('fusion_filter_adjust', position)).toMatchObject({
    ok: false,
    error: expect.stringContaining('Explicit-role'),
  });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});

it('accepts supported graph frequencies below the typed10Hz minimum without typed-decimal conversion', async () => {
  const f = fixture();
  expect(
    await f.execute('fusion_filter_adjust', { ...position, frequency: 5, axisY: 1 }),
  ).toMatchObject({ ok: true });
  expect(f.state().documents.left.presets[0].channels[0].filters[0].frequency).toBe(5);
});
