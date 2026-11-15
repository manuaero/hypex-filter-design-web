import { it, expect, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type DocumentState,
} from '../src/application/tools';
import { newProject, type HfdProjectCalibration } from '../src/domain/model';
import type { Backup } from '../src/hardware/session';
import * as backupFiles from '../src/hardware/backup-file';
import type { EqBank } from '../src/domain/equalizer';
import { decodeEq } from '../src/hardware/codec';
it('previews a proposed filter without editing and rejects unstable custom coefficients', async () => {
  const { execute, state } = setup(),
    before = structuredClone(state().documents);
  const result = (await execute('fusion_preview_filter', {
    filter: { kind: 'peak', frequency: 1000, q: 1, gain: 6 },
    frequencies: [1000],
  })) as { ok: boolean; points: { db: number }[] };
  expect(result.ok).toBe(true);
  expect(result.points[0].db).toBeCloseTo(6, 1);
  expect(state().documents).toEqual(before);
  const invalid = (await execute('fusion_preview_filter', {
    filter: { kind: 'raw', coefficients: { b0: 1, b1: 0, b2: 0, f1: 2, f2: 0 } },
    frequencies: [1000],
  })) as { ok: boolean };
  expect(invalid.ok).toBe(false);
});
function setup(options: { microphone?: boolean } = {}) {
  let state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: true,
  };
  const history: (typeof state.documents)[] = [],
    future: (typeof state.documents)[] = [];
  let eqBank: EqBank | undefined;
  let eqLabel = '';
  const remember = vi.fn((reference: HfdProjectCalibration | undefined) => {
    state = { ...state, rememberedHfdCalibration: structuredClone(reference) };
  });
  const adapter: ToolAdapter = {
    ...(options.microphone ? { microphone: { remember } } : {}),
    eqClipboard: {
      get: () => (eqBank ? structuredClone(eqBank) : undefined),
      set: (bank, label) => {
        eqBank = structuredClone(bank);
        eqLabel = label;
      },
      clear: () => {
        eqBank = undefined;
        eqLabel = '';
      },
      label: () => eqLabel,
    },
    state: () => state,
    edit: (slots, fn) => {
      const next = structuredClone(state.documents);
      slots.forEach((s) => fn(next[s]));
      history.push(state.documents);
      state = { ...state, documents: next };
    },
    choose: (p) => {
      state = { ...state, ...p };
    },
    undo: () => {
      const p = history.pop();
      if (p) {
        future.push(state.documents);
        state.documents = p;
      }
    },
    redo: () => {
      const p = future.pop();
      if (p) {
        history.push(state.documents);
        state.documents = p;
      }
    },
    connections: () => ({}),
    connect: async () => {
      throw Error('No device');
    },
    disconnect: async () => {},
    refresh: async () => {},
    operate: async (_, fn) => fn(),
    message: () => {},
    progress: () => {},
    view: () => {},
  };
  return { execute: createToolExecutor(adapter), state: () => state, remember, adapter };
}
it('retains disabled raw coefficients under MCP bypass and latent edits and merges Both patches independently', async () => {
  const { execute, state, adapter } = setup();
  const vectors = {
    left: { b0: 0.12345678901234566, b1: -0.25, b2: 0.0625, f1: 0.4, f2: -0.1 },
    right: { b0: 0.75, b1: 0.1, b2: -0.02, f1: 0.2, f2: -0.03 },
  };
  for (const role of ['left', 'right'] as const) {
    const c = state().documents[role].presets[0].channels[0];
    Object.assign(c.filters[0], { kind: 'raw', enabled: false, coefficients: vectors[role] });
    c.coefficientCache = 'unresolved';
  }
  const before = structuredClone(state().documents);
  const input = { target: 'both', preset: 1, channel: 1, index: 1 };
  expect(await execute('fusion_filter_set', { ...input, patch: { enabled: true } })).toMatchObject({
    ok: true,
  });
  for (const role of ['left', 'right'] as const)
    expect(state().documents[role].presets[0].channels[0].filters[0].coefficients).toEqual(
      vectors[role],
    );
  expect(
    await execute('fusion_filter_set', { ...input, patch: { enabled: false, frequency: 2200 } }),
  ).toMatchObject({ ok: true });
  const edit = vi.spyOn(adapter, 'edit');
  const beforeCoefficientEdit = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_set', {
      ...input,
      patch: { coefficients: { b0: 0.3333333333333333 } },
    }),
  ).toMatchObject({ ok: true });
  expect(edit).toHaveBeenCalledTimes(1);
  for (const role of ['left', 'right'] as const) {
    const c = state().documents[role].presets[0].channels[0];
    expect(c.filters[0].coefficients).toEqual({ ...vectors[role], b0: 0.3333333333333333 });
    expect(c.filters[0].enabled).toBe(false);
    expect(c.coefficientCache).toBe('unresolved');
    expect(c.filters[0].id).toBe(before[role].presets[0].channels[0].filters[0].id);
  }
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(beforeCoefficientEdit);
});
it('preflights every raw coefficient target, rejects malformed patches, and preserves history on refusal', async () => {
  const { execute, state, adapter } = setup();
  for (const role of ['left', 'right'] as const)
    Object.assign(state().documents[role].presets[0].channels[0].filters[0], {
      kind: 'raw',
      coefficients: { b0: 1, b1: 0.1, b2: 0.2, f1: 0.3, f2: -0.1 },
    });
  const edit = vi.spyOn(adapter, 'edit');
  delete state().documents.right.presets[0].channels[0].filters[0].coefficients;
  const before = structuredClone(state().documents);
  const input = { target: 'both', preset: 1, channel: 1, index: 1 };
  for (const coefficients of [{ b0: 0.5 }, {}, { b0: Infinity }, { b0: 0.5, unknown: 1 }])
    expect(await execute('fusion_filter_set', { ...input, patch: { coefficients } })).toMatchObject(
      { ok: false },
    );
  expect(edit).not.toHaveBeenCalled();
  expect(state().documents).toEqual(before);
  state().documents.right.presets[0].channels[0].linkedTo = 1;
  const linked = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_set', { ...input, patch: { coefficients: { b0: 0.5 } } }),
  ).toMatchObject({ ok: false });
  expect(edit).not.toHaveBeenCalled();
  expect(state().documents).toEqual(linked);
});
it('creates complete raw sections and converts each role from its retained unbypassed response', async () => {
  const { execute, state } = setup();
  const left = state().documents.left.presets[0].channels[0];
  const right = state().documents.right.presets[0].channels[0];
  Object.assign(left.filters[0], {
    kind: 'peak',
    enabled: false,
    coefficients: { b0: 0.9, b1: -0.2, b2: 0.1, f1: 0.3, f2: -0.05 },
  });
  Object.assign(right.filters[0], {
    kind: 'peak',
    enabled: true,
    coefficients: { b0: 0.8, b1: -0.4, b2: 0.2, f1: 0.1, f2: -0.02 },
  });
  const before = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_set', {
      target: 'both',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { kind: 'raw' },
    }),
  ).toMatchObject({ ok: true });
  for (const role of ['left', 'right'] as const) {
    const f = state().documents[role].presets[0].channels[0].filters[0];
    expect(f.coefficients).toEqual(before[role].presets[0].channels[0].filters[0].coefficients);
    expect(f.enabled).toBe(before[role].presets[0].channels[0].filters[0].enabled);
  }
  expect(
    await execute('fusion_filter_add', {
      target: 'both',
      preset: 1,
      channel: 1,
      kind: 'raw',
      frequency: 1000,
    }),
  ).toMatchObject({ ok: true });
  for (const role of ['left', 'right'] as const)
    expect(state().documents[role].presets[0].channels[0].filters[1].coefficients).toEqual({
      b0: 1,
      b1: 0,
      b2: 0,
      f1: 0,
      f2: 0,
    });
});
it('keeps raw no-op history exact and distinguishes partial raw edits from complete diagnostic or parameter overrides', async () => {
  const { execute, state, adapter } = setup();
  const c = state().documents.left.presets[0].channels[0];
  Object.assign(c.filters[0], {
    kind: 'raw',
    enabled: false,
    provenance: 'hfd',
    coefficients: { b0: 0.12345678901234566, b1: 0, b2: 0, f1: 0, f2: 0 },
  });
  const before = structuredClone(state().documents),
    edit = vi.spyOn(adapter, 'edit');
  const input = { target: 'left', preset: 1, channel: 1, index: 1 };
  expect(
    await execute('fusion_filter_set', {
      ...input,
      patch: { coefficients: { b0: 0.12345678901234566 } },
    }),
  ).toMatchObject({ ok: true });
  expect(edit).not.toHaveBeenCalled();
  expect(state().documents).toEqual(before);
  delete state().documents.left.presets[0].channels[0].filters[0].provenance;
  expect(
    await execute('fusion_filter_set', { ...input, patch: { coefficients: { b1: -0 } } }),
  ).toMatchObject({ ok: true });
  expect(
    Object.is(state().documents.left.presets[0].channels[0].filters[0].coefficients!.b1, -0),
  ).toBe(true);
  expect(edit).toHaveBeenCalledTimes(1);
  edit.mockClear();
  expect(
    await execute('fusion_filter_set', {
      ...input,
      index: 2,
      patch: { coefficients: { b0: 0.5 } },
    }),
  ).toMatchObject({ ok: false });
  expect(edit).not.toHaveBeenCalled();
  const full = { b0: 0.5, b1: 0, b2: 0, f1: 0, f2: 0 };
  expect(
    await execute('fusion_filter_set', {
      ...input,
      index: 2,
      patch: { kind: 'peak', coefficients: full },
    }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].filters[1]).toMatchObject({
    kind: 'peak',
    coefficients: full,
  });
  expect(
    await execute('fusion_preview_filter', {
      filter: { kind: 'raw', coefficients: { b0: 0.5 } },
      frequencies: [1000],
    }),
  ).toMatchObject({ ok: false });
});
it('exposes one strict wheel event with atomic independent Both changes, no-op preservation and one Undo', async () => {
  const { execute, state, adapter } = setup();
  const edits = vi.spyOn(adapter, 'edit');
  Object.assign(state().documents.left.presets[0].channels[0].filters[0], {
    kind: 'peak',
    q: 0.7,
    enabled: false,
  });
  Object.assign(state().documents.right.presets[0].channels[0].filters[0], {
    kind: 'lowpass2',
    q: 1.3,
    enabled: true,
  });
  const before = structuredClone(state().documents);
  expect(TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_filter_adjust')).toBeDefined();
  expect(TOOL_DEFINITIONS).toHaveLength(90);
  const event = {
    target: 'both',
    preset: 1,
    channel: 1,
    index: 1,
    parameter: 'q',
    direction: 'up',
  };
  expect(await execute('fusion_filter_adjust', event)).toMatchObject({
    ok: true,
    changed: true,
    basis: 'each',
    roles: [
      { slot: 'left', value: 0.74 },
      { slot: 'right', value: 1.34 },
    ],
  });
  expect(edits).toHaveBeenCalledTimes(1);
  for (const slot of ['left', 'right'] as const)
    expect(state().documents[slot].presets[0].channels[0].filters[0].enabled).toBe(
      before[slot].presets[0].channels[0].filters[0].enabled,
    );
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  Object.assign(state().documents.left.presets[0].channels[0].filters[0], {
    q: 20.00001,
    coefficients: { b0: 0.9, b1: 0, b2: 0, f1: 0.1, f2: 0 },
    provenance: 'hfd',
  });
  const documents = state().documents,
    left = state().documents.left;
  edits.mockClear();
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'left' })).toMatchObject({
    ok: true,
    changed: false,
  });
  expect(edits).not.toHaveBeenCalled();
  expect(state().documents).toBe(documents);
  expect(await execute('fusion_filter_adjust', event)).toMatchObject({ ok: true, changed: true });
  expect(edits).toHaveBeenCalledExactlyOnceWith(['right'], expect.any(Function));
  expect(state().documents.left).toEqual(left);
});

it('wheel preflight refuses inactive/linked roles atomically, while fixed-source mirror allows latent destinations', async () => {
  const { execute, state, adapter } = setup();
  const edits = vi.spyOn(adapter, 'edit');
  Object.assign(state().documents.left.presets[0].channels[0].filters[0], {
    kind: 'peak',
    gain: 7.5,
    enabled: false,
  });
  Object.assign(state().documents.right.presets[0].channels[0].filters[0], {
    kind: 'lowpass1',
    gain: 3,
    enabled: true,
  });
  const before = structuredClone(state().documents);
  const event = {
    target: 'both',
    preset: 1,
    channel: 1,
    index: 1,
    parameter: 'gain',
    direction: 'up',
  };
  expect(await execute('fusion_filter_adjust', event)).toMatchObject({ ok: false });
  expect(edits).not.toHaveBeenCalled();
  expect(state().documents).toEqual(before);
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'left' })).toMatchObject({
    ok: true,
    roles: [{ value: 7.6 }, { value: 7.6 }],
  });
  expect(state().documents.right.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'lowpass1',
    enabled: true,
    gain: 7.6,
  });
  await execute('fusion_history', { action: 'undo' });
  state().documents.right.presets[0].channels[0].linkedTo = 1;
  const linked = structuredClone(state().documents);
  edits.mockClear();
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'left' })).toMatchObject({
    ok: false,
  });
  expect(edits).not.toHaveBeenCalled();
  expect(state().documents).toEqual(linked);
});

it('wheel schema accepts single each/matching basis and rejects other roles or any custom arithmetic state', async () => {
  const { execute, state } = setup();
  Object.assign(state().documents.left.presets[0].channels[0].filters[0], { kind: 'peak', q: 0.7 });
  const event = {
    target: 'left',
    preset: 1,
    channel: 1,
    index: 1,
    parameter: 'q',
    direction: 'up',
  };
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'each' })).toMatchObject({
    ok: true,
  });
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'left' })).toMatchObject({
    ok: true,
  });
  const frozen = state().documents;
  for (const patch of [
    { basis: 'right' },
    { step: 0.5 },
    { state: {} },
    { displayedText: '0.7' },
    { additionalGain: 0 },
    { direction: 120 },
    { parameter: 'frequency' },
  ])
    expect(await execute('fusion_filter_adjust', { ...event, ...patch })).toMatchObject({
      ok: false,
    });
  expect(state().documents).toBe(frozen);
});
it('reports guarded native gain Text separately from stored values for independent Both and source-basis mirrors', async () => {
  const { execute, state, adapter } = setup();
  const edits = vi.spyOn(adapter, 'edit');
  for (const slot of ['left', 'right'] as const) {
    const channel = state().documents[slot].presets[0].channels[0];
    Object.assign(channel.filters[0], {
      kind: 'peak',
      gain: slot === 'left' ? 17.95 : 7.5,
      enabled: slot === 'right',
    });
    channel.additionalGain = slot === 'left' ? 10 : 0;
    channel.gain = -12;
  }
  const before = structuredClone(state().documents);
  const event = {
    target: 'both',
    preset: 1,
    channel: 1,
    index: 1,
    parameter: 'gain',
    direction: 'up',
  };
  expect(await execute('fusion_filter_adjust', event)).toMatchObject({
    ok: true,
    changed: true,
    basis: 'each',
    roles: [
      { slot: 'left', value: 18.05, text: '14.00' },
      { slot: 'right', value: 7.6, text: '7.60' },
    ],
  });
  expect(state().documents.left.presets[0].channels[0].filters[0].gain).toBe(18.05);
  expect(state().documents.right.presets[0].channels[0].filters[0].gain).toBe(7.6);
  expect(edits).toHaveBeenCalledTimes(1);
  // A new command opens a fresh passive field from its canonical model. It
  // intentionally does not inherit the human widget's retained Text 14.00.
  expect(await execute('fusion_filter_adjust', event)).toMatchObject({
    ok: true,
    roles: [
      { value: 18.15, text: '14.00' },
      { value: 7.7, text: '7.70' },
    ],
  });
  expect(state().documents.left.presets[0].channels[0].filters[0].gain).toBe(18.15);
  await execute('fusion_history', { action: 'undo' });
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  expect(await execute('fusion_filter_adjust', { ...event, basis: 'left' })).toMatchObject({
    ok: true,
    basis: 'left',
    roles: [
      { slot: 'left', value: 18.05, text: '14.00' },
      { slot: 'right', value: 18.05, text: '14.00' },
    ],
  });
  for (const slot of ['left', 'right'] as const)
    expect(state().documents[slot].presets[0].channels[0].filters[0].gain).toBe(18.05);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
});
it('uses shared Double Q/gain commits with independent Both zero values and preserves wider diagnostic validation', async () => {
  const { execute, state } = setup();
  Object.assign(state().documents.left.presets[0].channels[0].filters[0], {
    q: 0.4,
    q2: 0.7,
    gain: 6,
    enabled: false,
  });
  Object.assign(state().documents.right.presets[0].channels[0].filters[0], {
    q: 1.3,
    q2: 2.5,
    gain: -6,
    enabled: true,
  });
  const before = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_set', {
      target: 'both',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { q: 0.4005, q2: 0, gain: 7.555 },
      redesign: false,
    }),
  ).toMatchObject({ ok: true });
  for (const slot of ['left', 'right'] as const) {
    const filter = state().documents[slot].presets[0].channels[0].filters[0];
    expect(filter.q).toBe(0.401);
    expect(filter.q).not.toBe(Math.fround(filter.q));
    expect(filter.q2).toBe(before[slot].presets[0].channels[0].filters[0].q2);
    expect(filter.gain).toBe(7.56);
    expect(filter.enabled).toBe(before[slot].presets[0].channels[0].filters[0].enabled);
  }
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  expect(
    await execute('fusion_filter_set', {
      target: 'left',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { q: -5, q2: 99, gain: -999 },
    }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    q: 0.1,
    q2: 20,
    gain: -125,
  });
  expect(state().documents.right).toEqual(before.right);
  const frozen = structuredClone(state().documents);
  for (const patch of [{ q: NaN }, { q2: Infinity }, { gain: -Infinity }, { gain: 3, extra: true }])
    expect(
      await execute('fusion_filter_set', {
        target: 'both',
        preset: 1,
        channel: 1,
        index: 1,
        patch,
      }),
    ).toMatchObject({ ok: false });
  expect(state().documents).toEqual(frozen);
  expect(
    await execute('fusion_preview_filter', {
      filter: { kind: 'lowpass1', frequency: 1000, q: 50, gain: -96 },
      frequencies: [1000],
    }),
  ).toMatchObject({ ok: true });
});
it('commits explicit manual frequencies with native Text semantics while preserving independent Both bypass and untouched imports', async () => {
  const { execute, state } = setup();
  const left = state().documents.left.presets[0].channels[0].filters[0];
  const right = state().documents.right.presets[0].channels[0].filters[0];
  Object.assign(left, {
    enabled: false,
    kind: 'lowpass2',
    frequency: 720,
    frequency2: 988.101806640625,
  });
  Object.assign(right, {
    enabled: true,
    kind: 'lowpass2',
    frequency: 900,
    frequency2: 1777.123456789,
  });
  const before = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_set', {
      target: 'both',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { kind: 'highpass2', frequency: 10.35 },
    }),
  ).toMatchObject({ ok: true });
  for (const slot of ['left', 'right'] as const) {
    const filter = state().documents[slot].presets[0].channels[0].filters[0];
    expect(filter.frequency).toBe(10.399999618530273);
    expect(filter.frequency2).toBe(before[slot].presets[0].channels[0].filters[0].frequency2);
    expect(filter.enabled).toBe(before[slot].presets[0].channels[0].filters[0].enabled);
    expect(filter.id).toBe(before[slot].presets[0].channels[0].filters[0].id);
  }
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  expect(
    await execute('fusion_filter_set', {
      target: 'left',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { frequency: 0, frequency2: 50001, enabled: true },
    }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    frequency: 720,
    frequency2: 50000,
    enabled: true,
  });
  expect(state().documents.right).toEqual(before.right);
  const unused = state().documents.right.presets[0].channels[0].filters.findIndex(
    (filter) => filter.kind === 'unity',
  );
  expect(
    await execute('fusion_filter_add', { target: 'right', preset: 1, channel: 1, frequency: 1 }),
  ).toMatchObject({ ok: true });
  expect(state().documents.right.presets[0].channels[0].filters[unused].frequency).toBe(10);
  const frozen = structuredClone(state().documents);
  for (const patch of [
    { frequency: NaN },
    { frequency2: Infinity },
    { frequency: 1000, unexpected: true },
  ])
    expect(
      await execute('fusion_filter_set', {
        target: 'both',
        preset: 1,
        channel: 1,
        index: 1,
        patch,
      }),
    ).toMatchObject({ ok: false });
  expect(state().documents).toEqual(frozen);
  // Diagnostic preview remains independent of manual authoring bounds/rounding.
  expect(
    await execute('fusion_preview_filter', {
      filter: { kind: 'lowpass1', frequency: 1 },
      frequencies: [10],
    }),
  ).toMatchObject({ ok: true });
});
it('analyzes measured complex responses and included-channel sums without editing the designs', async () => {
  const { execute, state } = setup();
  const pr = state().documents.left.presets[0];
  for (const c of pr.channels.slice(0, 2))
    c.measurement = {
      name: 'Known quadrature response',
      sampleRate: 48000,
      frequency: [100, 1000, 10000],
      magnitude: [-6, -6, -6],
      phase: [90, 90, 90],
    };
  pr.channels[1].invert = true;
  pr.channels[2].includeInSum = false;
  const before = structuredClone(state().documents);
  const input = { slot: 'left', preset: 1, frequencies: [1000] };
  type Analysis = {
    ok: boolean;
    points: {
      channels: { real: number; imaginary: number; db: number }[];
      sumReal: number;
      sumImaginary: number;
      sumPhaseDegrees: number;
    }[];
  };
  const electrical = (await execute('fusion_analyze', input)) as Analysis;
  expect(electrical.points[0].channels[0].db).toBeCloseTo(0, 12);
  const measured = (await execute('fusion_analyze', { ...input, measured: true })) as Analysis;
  expect(measured.points[0].channels[0].real).toBeCloseTo(0, 12);
  expect(measured.points[0].channels[0].imaginary).toBeCloseTo(10 ** (-6 / 20), 12);
  expect(measured.points[0].sumReal).toBeCloseTo(0, 12);
  expect(measured.points[0].sumImaginary).toBeCloseTo(0, 12);
  expect(state().documents).toEqual(before);
  pr.channels[1].includeInSum = false;
  const single = (await execute('fusion_analyze', { ...input, measured: true })) as Analysis;
  expect(single.points[0].sumImaginary).toBeCloseTo(10 ** (-6 / 20), 12);
  expect(single.points[0].sumPhaseDegrees).toBeCloseTo(90, 12);
});
it('validates command schemas and exposes unique complete tool definitions', async () => {
  expect(new Set(TOOL_DEFINITIONS.map((t) => t.name)).size).toBe(TOOL_DEFINITIONS.length);
  for (const tool of TOOL_DEFINITIONS) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.description.length).toBeGreaterThan(20);
  }
  const { execute } = setup();
  expect(await execute('unknown', {})).toEqual({ ok: false, error: 'Unknown tool' });
  expect(
    ((await execute('fusion_filter_set', { target: 'both', preset: 0 })) as { ok: boolean }).ok,
  ).toBe(false);
  expect(
    (
      (await execute('fusion_controls', { target: 'left', patch: { firmwareErase: true } })) as {
        ok: boolean;
      }
    ).ok,
  ).toBe(false);
});

it('advertises caller input optionality instead of requiring values supplied by runtime defaults', async () => {
  const schema = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name)!.inputSchema;
  expect(schema('fusion_state').required ?? []).toEqual([]);
  expect(schema('fusion_project_export').required).toEqual(['slot']);
  expect(schema('fusion_analyze').required).toEqual(['slot', 'preset', 'frequencies']);
  expect(schema('fusion_hfd_measurement').required).toEqual(['target', 'preset', 'action']);
  expect(schema('fusion_rename').required).toEqual(['target', 'name']);
  expect(schema('fusion_microphone').required).toEqual(['target', 'action']);
  expect(schema('fusion_project_export').additionalProperties).toBe(false);
  const { execute } = setup();
  const exported = (await execute('fusion_project_export', { slot: 'left' })) as {
    ok: boolean;
    content: string;
  };
  expect(exported.ok).toBe(true);
  expect(JSON.parse(exported.content).format).toBe('fusion-studio-project');
});

it('renames existing stereo documents atomically without replacing their designs or selection, with one Undo', async () => {
  const { execute, state } = setup();
  state().documents.left.presets[0].channels[0].filters[14].gain = 4;
  const before = structuredClone(state()),
    expected = structuredClone(before.documents);
  expected.left.name = expected.right.name = 'Stereo design';
  expect(await execute('fusion_rename', { target: 'both', name: 'Stereo design' })).toEqual({
    ok: true,
  });
  expect(state().documents).toEqual(expected);
  expect({ ...state(), documents: before.documents }).toEqual(before);
  expect(state().documents.left.presets).not.toBe(state().documents.right.presets);
  await execute('fusion_history', { action: 'undo' });
  expect(state()).toEqual(before);
  await execute('fusion_history', { action: 'redo' });
  expect(state().documents).toEqual(expected);
});

it('renames a selected preset independently and keeps project/preset name validation consistent with the UI model', async () => {
  const { execute, state } = setup(),
    before = structuredClone(state().documents),
    name = 'P'.repeat(201),
    expected = structuredClone(before);
  expected.left.presets[1].name = name;
  expect(await execute('fusion_rename', { target: 'left', preset: 2, name })).toEqual({ ok: true });
  expect(state().documents).toEqual(expected);
  const failed = (await execute('fusion_rename', { target: 'both', name })) as { ok: boolean };
  expect(failed.ok).toBe(false);
  expect(state().documents).toEqual(expected);
  expect(
    (
      (await execute('fusion_rename', { target: 'left', preset: 4, name: 'Invalid' })) as {
        ok: boolean;
      }
    ).ok,
  ).toBe(false);
  expect(state().documents).toEqual(expected);
});

it('imports an external recovery file offline without editing designs or requiring an amplifier', async () => {
  const { execute, state } = setup(),
    before = structuredClone(state()),
    backup: Backup = {
      format: 'fusion-studio-backup',
      version: 1,
      id: 'imported-recovery',
      utc: '2026-11-14T00:00:00.000Z',
      serial: 'OWNED-PANEL',
      product: 22,
      firmware: '5.7',
      preset: 2,
      address: 0x23000,
      name: 'Owned panel',
      configuration_hex: '00'.repeat(64),
      status_hex: '00'.repeat(64),
      sector_hex: '00'.repeat(4096),
      sha256: 'a'.repeat(64),
    },
    imported = vi.spyOn(backupFiles, 'importBackupFile').mockResolvedValue(backup);
  try {
    expect(await execute('fusion_backup_import', { content: 'Owned recovery file' })).toEqual({
      ok: true,
      backupId: backup.id,
      serial: backup.serial,
      preset: backup.preset,
      address: backup.address,
      sha256: backup.sha256,
    });
    expect(imported).toHaveBeenCalledWith('Owned recovery file');
    expect(state()).toEqual(before);
    imported.mockRejectedValueOnce(new Error('Backup sector SHA-256 mismatch'));
    const failed = (await execute('fusion_backup_import', {
      content: 'Corrupt recovery file',
    })) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('SHA-256');
    expect(state()).toEqual(before);
  } finally {
    imported.mockRestore();
  }
});

it('loads independent project-wide microphone resources, preserves apply flags/originals, and remembers only explicit file selection', async () => {
  const { execute, state, remember } = setup({ microphone: true }),
    text = [1, ...Array(15).fill(0)].join('\n');
  await execute('fusion_measurement_set', {
    target: 'both',
    preset: 1,
    channel: 1,
    name: 'Driver',
    text,
    format: 'impulse',
    analysis: 'hfd',
  });
  await execute('fusion_hfd_measurement', {
    target: 'both',
    preset: 1,
    channel: 1,
    action: 'options',
    patch: { applyMicCorrection: true },
  });
  const before = structuredClone(state().documents),
    beforeInspect = structuredClone(state());
  const inspected = (await execute('fusion_microphone', { target: 'both', action: 'inspect' })) as {
    ok: boolean;
    projects: { loaded: boolean }[];
  };
  expect(inspected.ok).toBe(true);
  expect(inspected.projects.every((p) => !p.loaded)).toBe(true);
  expect(state()).toEqual(beforeInspect);
  expect(remember).not.toHaveBeenCalled();
  const result = (await execute('fusion_microphone', {
    target: 'both',
    action: 'load',
    name: 'Owned.txt',
    content: '10 6\n24000 6',
  })) as {
    ok: boolean;
    projects: { loaded: boolean; available: boolean; points: number; applyFlags: boolean[][] }[];
  };
  expect(result.ok).toBe(true);
  expect(result.projects.every((p) => p.loaded && p.available && p.points === 2)).toBe(true);
  expect(
    result.projects.every(
      (p) => p.applyFlags[0][0] && p.applyFlags.flat().filter(Boolean).length === 1,
    ),
  ).toBe(true);
  for (const role of ['left', 'right'] as const) {
    expect(state().documents[role].presets[0].channels[0].measurement!.impulse).toEqual(
      before[role].presets[0].channels[0].measurement!.impulse,
    );
    expect(
      state().documents[role].presets[0].channels[0].measurement!.processing?.calibration,
    ).toBeUndefined();
  }
  expect(state().documents.left.hfdCalibration).not.toBe(state().documents.right.hfdCalibration);
  expect(state().documents.left.hfdCalibration!.resource!.curve.frequency).not.toBe(
    state().documents.right.hfdCalibration!.resource!.curve.frequency,
  );
  expect(remember).toHaveBeenCalledTimes(1);
  expect(state().rememberedHfdCalibration!.filename).toBe('Owned.txt');
  await execute('fusion_microphone', {
    target: 'left',
    action: 'options',
    showCurve: true,
    smoothingOctaves: 1 / 3,
  });
  expect(state().documents.left.hfdCalibration).toMatchObject({
    showCurve: true,
    smoothingOctaves: 1 / 3,
  });
  expect(state().documents.right.hfdCalibration!.showCurve).toBe(false);
  expect(remember).toHaveBeenCalledTimes(1);
  await execute('fusion_microphone', { target: 'both', action: 'unload' });
  expect(state().documents.left.presets[0].channels[0].hfdMeasurement!.applyMicCorrection).toBe(
    true,
  );
  expect(state().documents.left.hfdCalibration!.loaded).toBe(false);
  expect(state().rememberedHfdCalibration).toBeUndefined();
  expect(remember).toHaveBeenCalledTimes(2);
});

it('keeps microphone actions atomic on invalid data and supports adapters without remembered-resource storage', async () => {
  const { execute, state, remember } = setup({ microphone: true }),
    before = structuredClone(state());
  for (const input of [
    { target: 'both', action: 'load', name: 'Bad.txt', content: 'not a native correction' },
    { target: 'both', action: 'load' },
    { target: 'both', action: 'options', smoothingOctaves: 4 },
    { target: 'both', action: 'options' },
  ])
    expect(((await execute('fusion_microphone', input)) as { ok: boolean }).ok).toBe(false);
  expect(state()).toEqual(before);
  expect(remember).not.toHaveBeenCalled();
  const simple = setup();
  expect(
    (
      (await simple.execute('fusion_microphone', {
        target: 'left',
        action: 'load',
        name: 'Owned.txt',
        content: '10 0\n24000 0',
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  expect(simple.remember).not.toHaveBeenCalled();
});

it('New inherits each current project file, never startup memory, and imports clear absent optional fields without remembering', async () => {
  const { execute, state, remember } = setup({ microphone: true });
  await execute('fusion_microphone', {
    target: 'left',
    action: 'load',
    name: 'A.txt',
    content: '10 1\n24000 1',
  });
  await execute('fusion_microphone', {
    target: 'right',
    action: 'load',
    name: 'B.txt',
    content: '10 2\n24000 2',
  });
  const projectA = structuredClone(state().documents.left);
  await execute('fusion_microphone', {
    target: 'left',
    action: 'load',
    name: 'StartupC.txt',
    content: '10 3\n24000 3',
  });
  expect(state().rememberedHfdCalibration!.filename).toBe('StartupC.txt');
  state().documents.left.sourceXml = '<old-source />';
  const calls = remember.mock.calls.length;
  await execute('fusion_project_import', { target: 'left', content: JSON.stringify(projectA) });
  expect(state().documents.left.sourceXml).toBeUndefined();
  expect(state().documents.left.hfdCalibration!.filename).toBe('A.txt');
  expect(remember).toHaveBeenCalledTimes(calls);
  await execute('fusion_project_new', { target: 'both', name: 'Fresh stereo' });
  expect(state().documents.left.hfdCalibration!.filename).toBe('A.txt');
  expect(state().documents.right.hfdCalibration!.filename).toBe('B.txt');
  expect(state().rememberedHfdCalibration!.filename).toBe('StartupC.txt');
  expect(state().documents.left.hfdCalibration).not.toBe(state().documents.right.hfdCalibration);
  await execute('fusion_project_import', {
    target: 'left',
    content: JSON.stringify(newProject('No microphone')),
  });
  expect(state().documents.left.hfdCalibration).toBeUndefined();
  await execute('fusion_project_new', { target: 'left', name: 'Still no microphone' });
  expect(state().documents.left.hfdCalibration).toBeUndefined();
  expect(state().rememberedHfdCalibration!.filename).toBe('StartupC.txt');
  expect(remember).toHaveBeenCalledTimes(calls);
});

it('routes the native calibration compatibility command through the project resource and leaves browser calibration separate', async () => {
  const native = setup({ microphone: true }),
    text = [1, ...Array(15).fill(0)].join('\n');
  await native.execute('fusion_measurement_set', {
    target: 'both',
    preset: 1,
    channel: 1,
    name: 'Driver',
    text,
    format: 'impulse',
    analysis: 'hfd',
  });
  expect(
    (
      (await native.execute('fusion_measurement_calibrate', {
        target: 'both',
        preset: 1,
        channel: 1,
        name: 'Native.txt',
        content: '10 6\n24000 6',
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  for (const role of ['left', 'right'] as const) {
    const project = native.state().documents[role];
    expect(project.hfdCalibration!.loaded).toBe(true);
    expect(project.presets[0].channels[0].hfdMeasurement!.applyMicCorrection).toBe(true);
    expect(project.presets[0].channels[1].hfdMeasurement?.applyMicCorrection ?? false).toBe(false);
    expect(project.presets[0].channels[0].measurement!.processing?.calibration).toBeUndefined();
  }
  expect(native.remember).toHaveBeenCalledTimes(1);
  const browser = setup({ microphone: true });
  await browser.execute('fusion_measurement_set', {
    target: 'left',
    preset: 1,
    channel: 1,
    name: 'Legacy driver',
    text,
    format: 'impulse',
    analysis: 'browser',
  });
  expect(
    (
      (await browser.execute('fusion_measurement_calibrate', {
        target: 'left',
        preset: 1,
        channel: 1,
        name: 'Browser.cal',
        content: '10 6 30\n24000 6 30',
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  expect(browser.state().documents.left.hfdCalibration).toBeUndefined();
  expect(
    browser.state().documents.left.presets[0].channels[0].measurement!.processing!.calibration!
      .phase,
  ).toEqual([30, 30]);
  expect(browser.remember).not.toHaveBeenCalled();
});

it('bypasses, re-enables and clears local native correction through the legacy processing command without unloading the project file', async () => {
  const { execute, state, remember } = setup({ microphone: true }),
    text = [1, ...Array(31).fill(0)].join('\n');
  await execute('fusion_measurement_set', {
    target: 'left',
    preset: 1,
    channel: 1,
    name: 'Driver',
    text,
    format: 'impulse',
    analysis: 'hfd',
  });
  await execute('fusion_microphone', {
    target: 'left',
    action: 'load',
    name: 'Project.txt',
    content: '10 6\n24000 6',
  });
  const project = () => state().documents.left,
    channel = () => project().presets[0].channels[0],
    resource = structuredClone(project().hfdCalibration),
    original = channel().measurement!.impulse!.slice(),
    phase = structuredClone(channel().measurement!.hfdPhase);
  expect(
    (
      (await execute('fusion_measurement_processing', {
        target: 'left',
        preset: 1,
        channel: 1,
        calibrationEnabled: true,
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  const corrected = structuredClone(channel().measurement!.hfdMagnitude);
  expect(channel().hfdMeasurement!.applyMicCorrection).toBe(true);
  expect(channel().measurement!.processing?.calibration).toBeUndefined();
  expect(
    (
      (await execute('fusion_measurement_processing', {
        target: 'left',
        preset: 1,
        channel: 1,
        calibrationEnabled: false,
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  expect(channel().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(channel().measurement!.hfdMagnitude!.linearMagnitude[512]).toBeCloseTo(1, 10);
  expect(channel().measurement!.hfdMagnitude!.linearMagnitude[512]).not.toBeCloseTo(
    corrected!.linearMagnitude[512],
    5,
  );
  await execute('fusion_measurement_processing', {
    target: 'left',
    preset: 1,
    channel: 1,
    calibrationEnabled: true,
  });
  expect(channel().measurement!.hfdMagnitude).toEqual(corrected);
  channel().measurement!.processing = {
    smoothingOctaves: 0,
    calibrationEnabled: true,
    calibration: {
      name: 'Old browser curve',
      sampleRate: 48000,
      frequency: [10, 24000],
      magnitude: [1, 1],
    },
  };
  expect(
    (
      (await execute('fusion_measurement_processing', {
        target: 'left',
        preset: 1,
        channel: 1,
        clearCalibration: true,
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  expect(channel().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(channel().measurement!.processing?.calibration).toBeUndefined();
  expect(project().hfdCalibration).toEqual(resource);
  expect(channel().measurement!.impulse).toEqual(original);
  expect(channel().measurement!.hfdPhase).toEqual(phase);
  expect(remember).toHaveBeenCalledTimes(1);
});
it('converts measurement processing explicitly and snapshots independent stereo crop starts atomically', async () => {
  const { execute, state } = setup(),
    text = [1, ...Array(255).fill(0)].join('\n');
  await execute('fusion_measurement_set', {
    target: 'both',
    preset: 1,
    channel: 1,
    name: 'Raw',
    text,
    format: 'impulse',
    analysis: 'browser',
  });
  expect(state().documents.left.presets[0].channels[0].measurement).not.toBe(
    state().documents.right.presets[0].channels[0].measurement,
  );
  const before = structuredClone(state().documents);
  expect(
    (
      (await execute('fusion_hfd_measurement', {
        target: 'both',
        preset: 1,
        action: 'inspect',
      })) as { ok: boolean }
    ).ok,
  ).toBe(true);
  expect(state().documents).toEqual(before);
  await execute('fusion_hfd_measurement', { target: 'both', preset: 1, action: 'enable-preset' });
  await execute('fusion_hfd_measurement', {
    target: 'left',
    preset: 1,
    channel: 1,
    action: 'options',
    patch: { localStart: 10 },
  });
  await execute('fusion_hfd_measurement', {
    target: 'right',
    preset: 1,
    channel: 1,
    action: 'options',
    patch: { localStart: 20 },
  });
  await execute('fusion_hfd_measurement', {
    target: 'both',
    preset: 1,
    action: 'share',
    sourceChannel: 1,
  });
  expect(
    state().documents.left.presets[0].channels.map((c) => c.hfdMeasurement?.sharedStart),
  ).toEqual([10, 10, 10]);
  expect(
    state().documents.right.presets[0].channels.map((c) => c.hfdMeasurement?.sharedStart),
  ).toEqual([20, 20, 20]);
  await execute('fusion_hfd_measurement', {
    target: 'left',
    preset: 1,
    channel: 1,
    action: 'options',
    patch: { localStart: 30 },
  });
  expect(state().documents.left.presets[0].channels[0].hfdMeasurement?.sharedStart).toBe(10);
  const shared = structuredClone(state().documents);
  await execute('fusion_hfd_measurement', {
    target: 'left',
    preset: 1,
    action: 'share',
    sourceChannel: null,
  });
  expect(state().documents.left.presets[0].channels[0].hfdMeasurement?.localStart).toBe(30);
  expect(state().documents.left.presets[0].channels[0].hfdMeasurement?.sharedGroupId).toBe(-1);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(shared);
  const invalid = (await execute('fusion_hfd_measurement', {
    target: 'both',
    preset: 1,
    action: 'options',
    patch: { smoothPostBw: 11 },
  })) as { ok: boolean };
  expect(invalid.ok).toBe(false);
  expect(state().documents).toEqual(shared);
});
it('reports native phase-view values separately from the corrected magnitude-complex source', async () => {
  const { execute, state } = setup(),
    samples = Array(256).fill(0);
  samples[0] = 0.25;
  samples[20] = 1;
  await execute('fusion_measurement_set', {
    target: 'left',
    preset: 1,
    channel: 1,
    name: 'Two arrivals',
    text: samples.join('\n'),
    format: 'impulse',
    analysis: 'hfd',
  });
  await execute('fusion_hfd_measurement', {
    target: 'left',
    preset: 1,
    channel: 1,
    action: 'options',
    patch: { phaseStart: 20, stopInclusive: 127, smoothPostBw: 0.0001 },
  });
  const result = (await execute('fusion_analyze', {
    slot: 'left',
    preset: 1,
    measured: true,
    nativeCentered: false,
    frequencies: [1000],
  })) as {
    ok: boolean;
    points: { channels: { phaseDegrees: number; viewPhaseDegrees: number }[] }[];
  };
  expect(result.ok).toBe(true);
  expect(Math.abs(result.points[0].channels[0].phaseDegrees)).toBeGreaterThan(10);
  expect(result.points[0].channels[0].viewPhaseDegrees).toBeCloseTo(0, 10);
  expect(state().documents.left.presets[0].channels[0].measurement?.impulse).toEqual(samples);
  const before = structuredClone(state().documents);
  const failed = (await execute('fusion_hfd_measurement', {
    target: 'both',
    preset: 1,
    action: 'options',
    patch: { localStart: 15 },
  })) as { ok: boolean };
  expect(failed.ok).toBe(false);
  expect(state().documents).toEqual(before);
});
it('exposes the shared native time analysis, envelope points, sum, scope and range guards read-only', async () => {
  const { execute, state } = setup(),
    p = state().documents.left.presets[0];
  for (const c of p.channels.slice(0, 2))
    c.measurement = {
      name: 'Known delayed impulse',
      sampleRate: 1000,
      impulse: [0, 1, 0, 0],
      processing: {
        window: { start: 0, end: 4, taper: 0, timeZero: 0 },
        smoothingOctaves: 0,
        calibrationEnabled: false,
      },
    };
  p.channels[1].invert = true;
  const before = structuredClone(state().documents);
  type Curve = {
    source: string;
    sampleRate: number;
    sampleCount: number;
    peak: { timeMs: number; value: number };
    points: { timeMs: number; value: number }[];
  };
  type Analysis = { ok: boolean; channels: Curve[]; sum: Curve; warnings: string[] };
  const result = (await execute('fusion_time_analyze', {
    slot: 'left',
    preset: 1,
    measured: true,
    points: 16,
  })) as Analysis;
  expect(result.ok).toBe(true);
  expect(result.channels[0].source).toBe('measured-impulse');
  expect(result.channels[0].sampleRate).toBe(1000);
  expect(result.channels[0].sampleCount).toBe(4);
  expect(result.channels[0].peak.timeMs).toBe(1);
  expect(result.sum.points.every((p) => Math.abs(p.value) < 1e-12)).toBe(true);
  expect(result.warnings.some((w) => /endpoint|DC/.test(w))).toBe(true);
  const step = (await execute('fusion_time_analyze', {
    slot: 'left',
    preset: 1,
    measured: true,
    mode: 'Step',
    timeMinMs: 0,
    timeMaxMs: 4,
  })) as Analysis;
  expect(step.channels[0].peak.value).toBeCloseTo(2, 12);
  expect(state().documents).toEqual(before);
  p.channels[0].coefficientCache = 'unresolved';
  p.channels[0].gain = -20;
  const eq = (await execute('fusion_time_analyze', {
    slot: 'left',
    preset: 1,
    scope: 'input-eq',
    measured: true,
    points: 8,
  })) as Analysis;
  expect(eq.channels).toHaveLength(1);
  expect(eq.channels[0].source).toBe('electrical');
  expect(eq.channels[0].peak.value).toBeCloseTo(1, 10);
  expect(
    (
      (await execute('fusion_time_analyze', {
        slot: 'left',
        preset: 1,
        timeMinMs: 5,
        timeMaxMs: 4,
      })) as { ok: boolean }
    ).ok,
  ).toBe(false);
  expect(
    ((await execute('fusion_view', { timeMinMs: 5, timeMaxMs: 4 })) as { ok: boolean }).ok,
  ).toBe(false);
});
it('edits two independent documents, reorders/resets filters, copies presets and undoes atomically', async () => {
  const { execute, state } = setup();
  await execute('fusion_filter_set', {
    target: 'both',
    preset: 1,
    channel: 1,
    index: 1,
    patch: { kind: 'peak', enabled: true, gain: 3, frequency: 300, q: 1 },
  });
  expect(state().documents.left.presets[0].channels[0].filters[0].gain).toBe(3);
  expect(state().documents.right.presets[0].channels[0].filters[0].gain).toBe(3);
  await execute('fusion_filter_move', { target: 'left', preset: 1, channel: 1, from: 1, to: 4 });
  expect(state().documents.left.presets[0].channels[0].filters[3].gain).toBe(3);
  expect(state().documents.right.presets[0].channels[0].filters[0].gain).toBe(3);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents.left.presets[0].channels[0].filters[0].gain).toBe(3);
  await execute('fusion_copy', { from: 'left', to: 'right', preset: 1, destinationPreset: 3 });
  await execute('fusion_filter_reset', { target: 'left', preset: 1, channel: 1, index: 1 });
  expect(state().documents.right.presets[2].channels[0].filters[0].gain).toBe(3);
  expect(state().documents.left.presets[0].channels[0].filters[0].kind).toBe('unity');
});
it('analyzes the same input EQ/FIR chain and supports FIR placement and unload', async () => {
  const { execute, state } = setup();
  await execute('fusion_eq_set', {
    target: 'left',
    preset: 1,
    index: 1,
    patch: { enabled: true, kind: 'peak', frequency: 1000, q: 1, gain: 6 },
    enabled: true,
  });
  const r = (await execute('fusion_analyze', { slot: 'left', preset: 1, frequencies: [1000] })) as {
    ok: boolean;
    points: { channels: { db: number }[] }[];
  };
  expect(r.ok).toBe(true);
  expect(r.points[0].channels[0].db).toBeCloseTo(6, 1);
  await execute('fusion_fir_set', {
    target: 'left',
    preset: 1,
    channel: 0,
    name: 'delay',
    text: Array.from({ length: 4500 }, (_, i) => (i === 1 ? 1 : 0)).join('\n'),
    enabled: true,
  });
  expect(state().documents.left.presets[0].inputFir.enabled).toBe(true);
  await execute('fusion_fir_placement', { target: 'left', preset: 1, placement: 'output' });
  expect(state().documents.left.presets[0].inputFir.enabled).toBe(true);
  expect(state().documents.left.presets[0].inputFir.hfdState?.used).toBe(false);
  await execute('fusion_fir_set', {
    target: 'left',
    preset: 1,
    channel: 0,
    name: '',
    clear: true,
    enabled: false,
  });
  expect(state().documents.left.presets[0].inputFir.taps).toEqual([]);
});
it('imports/windows/exports impulses through validated agent commands', async () => {
  const { execute, state } = setup();
  const samples = Array.from({ length: 64 }, (_, i) => (i === 12 ? 1 : 0)).join('\n');
  expect(
    await execute('fusion_measurement_set', {
      target: 'left',
      preset: 1,
      channel: 1,
      name: 'Impulse',
      text: samples,
      format: 'impulse',
      sampleRate: 96000,
    }),
  ).toEqual({ ok: true });
  expect(state().documents.left.presets[0].channels[0].measurement?.sampleRate).toBe(96000);
  expect(
    await execute('fusion_measurement_window', {
      target: 'left',
      preset: 1,
      channel: 1,
      start: 0,
      end: 64,
      taper: 0,
      timeZero: 12,
    }),
  ).toEqual({ ok: true });
  const result = (await execute('fusion_measurement_export', {
    slot: 'left',
    preset: 1,
    channel: 1,
    format: 'impulse',
  })) as { ok: boolean; content: string };
  expect(result.content).toBe(samples);
  const before = structuredClone(state().documents);
  expect(
    (
      (await execute('fusion_measurement_window', {
        target: 'both',
        preset: 1,
        channel: 1,
        start: 0,
        end: 999,
        taper: 0,
        timeZero: 0,
      })) as { ok: boolean }
    ).ok,
  ).toBe(false);
  expect(state().documents).toEqual(before);
});
it('fails unavailable hardware explicitly and never reports a completed upload', async () => {
  const { execute } = setup();
  for (const [name, args] of [
    ['fusion_upload', { target: 'both', preset: 1 }],
    ['fusion_power', { target: 'left', state: 'on' }],
    ['fusion_eq_read', { slot: 'left', preset: 1 }],
    ['fusion_fir_upload', { target: 'both', preset: 1 }],
  ] as const) {
    const result = (await execute(name, args)) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not connected');
  }
});
it('exchanges independent stereo designs atomically and restores both with one undo', async () => {
  const { execute, state } = setup();
  const left = state().documents.left.presets[0].channels[0];
  const right = state().documents.right.presets[0].channels[0];
  Object.assign(left.filters[0], { kind: 'peak', enabled: true, frequency: 120, gain: -3 });
  Object.assign(right.filters[0], { kind: 'peak', enabled: true, frequency: 180, gain: 2 });
  const before = structuredClone(state().documents);
  expect(
    await execute('fusion_biquad_exchange', {
      target: 'both',
      preset: 1,
      channel: 1,
      first: 1,
      second: 3,
    }),
  ).toEqual({ ok: true });
  for (const role of ['left', 'right'] as const) {
    const c = state().documents[role].presets[0].channels[0];
    expect(c.filters[0].id).toBe(before[role].presets[0].channels[0].filters[0].id);
    expect(c.filters[2].id).toBe(before[role].presets[0].channels[0].filters[2].id);
    expect(c.filters[2].frequency).toBe(role === 'left' ? 120 : 180);
  }
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  state().documents.right.presets[0].channels[1].linkedTo = 0;
  const linkedBefore = structuredClone(state().documents);
  const rejected = (await execute('fusion_channel_copy', {
    target: 'both',
    preset: 1,
    source: 1,
    destination: 2,
  })) as { ok: boolean };
  expect(rejected.ok).toBe(false);
  expect(state().documents).toEqual(linkedBefore);
});
it('exposes native-scope preset clear with undo and preserves separate driver measurements during copy', async () => {
  const { execute, state } = setup();
  const p = state().documents.left.presets[0];
  p.channels[0].gain = -8;
  p.channels[0].delayUs = 300;
  p.channels[0].filters[0].kind = 'peak';
  p.channels[0].filters[0].enabled = true;
  p.channels[1].measurement = { name: 'Destination driver', sampleRate: 48000, impulse: [0, 1, 0] };
  const destinationId = p.channels[1].id;
  expect(
    await execute('fusion_channel_copy', { target: 'left', preset: 1, source: 1, destination: 2 }),
  ).toEqual({ ok: true });
  const copied = state().documents.left.presets[0].channels[1];
  expect(copied.gain).toBe(-8);
  expect(copied.id).toBe(destinationId);
  expect(copied.measurement?.name).toBe('Destination driver');
  const beforeClear = structuredClone(state().documents);
  expect(await execute('fusion_preset_clear', { target: 'left', preset: 1 })).toEqual({ ok: true });
  const cleared = state().documents.left.presets[0];
  expect(cleared.channels[0].gain).toBe(0);
  expect(cleared.channels[0].delayUs).toBe(300);
  expect(cleared.channels[0].filters[0].kind).toBe('unity');
  expect(cleared.channels[0].filters[0].enabled).toBe(true);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(beforeClear);
});
it('measurement commands keep correction noncumulative across windowing, persistence and bypass', async () => {
  const { execute, state } = setup();
  const impulse = Array.from({ length: 64 }, (_, i) => (i === 12 ? 1 : 0)).join('\n');
  await execute('fusion_measurement_set', {
    target: 'both',
    preset: 1,
    channel: 2,
    name: 'Driver',
    text: impulse,
    format: 'impulse',
    sampleRate: 48000,
  });
  const correction = {
    target: 'both',
    preset: 1,
    channel: 2,
    name: 'Mic correction',
    content: '10 3\n1000 3\n24000 3',
  };
  await execute('fusion_measurement_calibrate', correction);
  await execute('fusion_measurement_calibrate', correction);
  await execute('fusion_measurement_window', {
    target: 'both',
    preset: 1,
    channel: 2,
    start: 8,
    end: 32,
    taper: 0,
    timeZero: 12,
  });
  const before = structuredClone(state().documents);
  const m = state().documents.left.presets[0].channels[1].measurement!;
  expect(m.magnitude![10]).toBeCloseTo(-3, 10);
  expect(m.processing?.calibrationEnabled).toBe(true);
  expect(m.processing?.window?.end).toBe(32);
  await execute('fusion_measurement_processing', {
    target: 'left',
    preset: 1,
    channel: 2,
    calibrationEnabled: false,
  });
  expect(state().documents.left.presets[0].channels[1].measurement!.magnitude![10]).toBeCloseTo(
    0,
    10,
  );
  expect(state().documents.right.presets[0].channels[1].measurement!.magnitude![10]).toBeCloseTo(
    -3,
    10,
  );
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(before);
  await execute('fusion_measurement_processing', {
    target: 'both',
    preset: 1,
    channel: 2,
    resetWindow: true,
    peakZero: true,
    sampleRate: 96000,
  });
  const changed = state().documents.left.presets[0].channels[1].measurement!;
  expect(changed.sampleRate).toBe(96000);
  expect(changed.processing?.window).toEqual({ start: 0, end: 64, taper: 0, timeZero: 12 });
  expect(changed.processing?.calibrationEnabled).toBe(true);
});
it('all-preset upload rejects an offline target without changing either project', async () => {
  const { execute, state } = setup(),
    before = structuredClone(state().documents);
  const result = (await execute('fusion_upload_all', { target: 'both' })) as {
    ok: boolean;
    error: string;
  };
  expect(result.ok).toBe(false);
  expect(result.error).toContain('not connected');
  expect(state().documents).toEqual(before);
});

it('EQ defaults, copy-all and transient bank operations preserve independent stereo designs and undo', async () => {
  const { execute, state } = setup();
  state().documents.left.presets[0].inputEq[0].q = 1.2;
  state().documents.right.presets[0].inputEq[0].q = 0.8;
  state().documents.left.presets[1].eqEnabled = true;
  const initial = structuredClone(state().documents);
  expect(await execute('fusion_eq_default', { target: 'both', preset: 1 })).toEqual({ ok: true });
  expect(state().documents.left.presets[0].inputEq[8].frequency).toBe(16000);
  expect(state().documents.left.presets[0].inputEq[0].q).toBe(1.2);
  expect(state().documents.right.presets[0].inputEq[0].q).toBe(0.8);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(initial);
  await execute('fusion_eq_set', {
    target: 'left',
    preset: 1,
    index: 1,
    patch: { gain: 3, enabled: true },
  });
  await execute('fusion_eq_copy_all', { target: 'left', preset: 1 });
  expect(state().documents.left.presets[2].inputEq[0].gain).toBe(3);
  expect(state().documents.left.presets[1].eqEnabled).toBe(true);
  expect(state().documents.right.presets[2].inputEq[0].gain).toBe(0);
  const bank = (await execute('fusion_eq_bank', { action: 'copy-design', source: 'left' })) as {
    ok: boolean;
  };
  expect(bank.ok).toBe(true);
  await execute('fusion_eq_set', { target: 'left', preset: 1, index: 1, patch: { gain: -2 } });
  await execute('fusion_eq_bank', { action: 'apply-design', target: 'right' });
  expect(state().documents.right.presets[0].inputEq[0].gain).toBe(3);
  expect(state().documents.left.presets[0].inputEq[0].gain).toBe(-2);
  const inspected = (await execute('fusion_eq_bank', { action: 'inspect' })) as { bank: EqBank };
  expect(inspected.bank[0].bands[0].gain).toBe(3);
  await execute('fusion_eq_bank', { action: 'clear' });
  expect(
    ((await execute('fusion_eq_bank', { action: 'inspect' })) as { bank: unknown }).bank,
  ).toBeNull();
  expect(
    (
      (await execute('fusion_eq_bank', { action: 'apply-design', target: 'both' })) as {
        ok: boolean;
      }
    ).ok,
  ).toBe(false);
});
it('input EQ rejects unsupported filters and out-of-range gain atomically and decodes erased band9 at16k', async () => {
  const { execute, state } = setup(),
    before = structuredClone(state().documents);
  for (const patch of [
    { kind: 'allpass2' },
    { kind: 'unity' },
    { gain: 40 },
    { coefficients: { b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 } },
  ])
    expect(
      (
        (await execute('fusion_eq_set', { target: 'both', preset: 1, index: 1, patch })) as {
          ok: boolean;
        }
      ).ok,
    ).toBe(false);
  expect(state().documents).toEqual(before);
  expect(decodeEq(new Uint8Array(4096).fill(255))[8].frequency).toBe(16000);
});
