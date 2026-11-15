import { expect, it, vi } from 'vitest';
import {
  createNativeImpulseView,
  nativeImpulseZoomFromRange,
  projectNativeImpulseZoom,
} from '../src/application/native-impulse-view';
import { createPlotViewController } from '../src/application/plot-view';
import { newProject, type HfdImpulseZoom } from '../src/domain/model';
import { defaultPlotRange } from '../src/domain/plot-viewport';
import { createWorkspaceStore } from '../src/state/workspace';

const saved: HfdImpulseZoom = { left: -0.003, right: 0.0125, top: 4, bottom: -2, use: true };
const context = { slot: 'left' as const, mode: 'Impulse' as const };
async function setup() {
  const { store, persistence } = createWorkspaceStore({
    read: async () => null,
    write: async () => {},
    readLegacy: () => null,
  });
  await persistence.hydrate();
  const documents = { left: newProject('Left'), right: newProject('Right') };
  store.setState({
    documents,
    slot: 'left',
    preset: 0,
    channel: 0,
    documentRevision: 7,
    past: [],
    future: [],
  });
  const plots = createPlotViewController(),
    edit = vi.fn((...args: Parameters<ReturnType<typeof store.getState>['editAt']>) =>
      store.getState().editAt(...args),
    ),
    service = createNativeImpulseView({ plots, state: store.getState, edit });
  return { store, plots, service, edit };
}
function zoom(plots: ReturnType<typeof createPlotViewController>) {
  plots.rectangle(
    context,
    { kind: 'zoom', axes: { xMin: 1, xMax: 7, yMin: -0.5, yMax: 0.75, xScale: 'linear' } },
    plots.getSnapshot().left.Impulse.range,
  );
}

it('projects native seconds and signed amplitudes without changing raw values or unrelated frequency axes', () => {
  const source = Object.freeze({ ...saved }),
    base = defaultPlotRange('Impulse'),
    projected = projectNativeImpulseZoom(source, base)!;
  expect(projected).toEqual({
    ...base,
    timeMinMs: -3,
    timeMaxMs: 12.5,
    amplitudeMin: -2,
    amplitudeMax: 4,
  });
  expect(nativeImpulseZoomFromRange(projected)).toEqual(saved);
  expect(source).toEqual(saved);
  expect(projectNativeImpulseZoom({ ...source, use: false }, base)).toBeUndefined();
  expect(projectNativeImpulseZoom({ ...source, left: 2, right: 1 }, base)).toBeUndefined();
  expect(projectNativeImpulseZoom({ ...source, right: Number.MAX_VALUE }, base)).toBeUndefined();
  expect(
    projectNativeImpulseZoom({ ...source, bottom: -Number.MAX_VALUE, top: Number.MAX_VALUE }, base),
  ).toBeUndefined();
  expect(projectNativeImpulseZoom({ ...source, left: -1e305, right: 1e305 }, base)).toBeUndefined();
  expect(projectNativeImpulseZoom(source, { ...base, frequencyMax: 100000 })).toBeUndefined();
  expect(() =>
    nativeImpulseZoomFromRange({ ...base, timeMinMs: 0, timeMaxMs: Number.MIN_VALUE }),
  ).toThrow(/represented/);
});

it('passively restores only Impulse without document mutation, measurement activation, Step coupling or inherited rectangle history', async () => {
  const { store, plots, service, edit } = await setup();
  store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom = { ...saved };
  zoom(plots);
  const before = store.getState(),
    views = plots.getSnapshot(),
    result = service.restore();
  expect(result).toMatchObject({
    restored: true,
    changed: true,
    bindingChanged: true,
    tupleChanged: true,
  });
  expect(plots.getSnapshot().left.Impulse).toMatchObject({
    touched: true,
    undoDepth: 0,
    canReverse: false,
    range: { timeMinMs: -3, timeMaxMs: 12.5, amplitudeMin: -2, amplitudeMax: 4 },
  });
  expect(plots.getSnapshot().left.Step).toBe(views.left.Step);
  expect(plots.getSnapshot().left.Magnitude).toBe(views.left.Magnitude);
  expect(plots.getSnapshot().right).toBe(views.right);
  expect(store.getState().documents).toBe(before.documents);
  expect(store.getState().documentRevision).toBe(before.documentRevision);
  expect(store.getState().past).toHaveLength(0);
  expect(store.getState().documents.left.presets[0].channels[0].hfdMeasurement).toBeUndefined();
  expect(edit).not.toHaveBeenCalled();
});

it('reports missing, disabled and invalid groups once without rewriting sentinel or malformed-but-preserved tuples', async () => {
  const { store, plots, service, edit } = await setup(),
    before = plots.getSnapshot();
  expect(service.restore()).toMatchObject({ changed: true, restored: false, reason: 'missing' });
  expect(service.restore()).toMatchObject({ changed: false, restored: false, reason: 'unchanged' });
  const disabled = { left: -1, right: -1, top: -1, bottom: -1, use: false };
  store.getState().documents.left.presets[0].channels[1].hfdImpulseZoom = disabled;
  store.getState().choose({ channel: 1 });
  expect(service.restore()).toMatchObject({
    changed: true,
    bindingChanged: true,
    reason: 'disabled',
  });
  expect(service.restore().changed).toBe(false);
  expect(store.getState().documents.left.presets[0].channels[1].hfdImpulseZoom).toBe(disabled);
  const invalid = { ...saved, left: 9, right: -2 };
  store.getState().documents.left.presets[0].channels[2].hfdImpulseZoom = invalid;
  store.getState().choose({ channel: 2 });
  expect(service.restore()).toMatchObject({ changed: true, reason: 'invalid' });
  expect(store.getState().documents.left.presets[0].channels[2].hfdImpulseZoom).toBe(invalid);
  expect(plots.getSnapshot()).toBe(before);
  expect(edit).not.toHaveBeenCalled();
});

it('writes exactly the captured role/group in one Undo entry, bypassing both role links and output processing normalization', async () => {
  const { store, service, plots, edit } = await setup(),
    selected = store.getState().documents.left.presets[0].channels[1];
  selected.linkedTo = 0;
  selected.gain = -9;
  selected.fir = {
    name: '',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  };
  store.getState().choose({ channel: 1, linkedEdits: true });
  const before = structuredClone(store.getState().documents),
    captured = service.capture();
  plots.update(context, { timeMinMs: -7, timeMaxMs: 13, amplitudeMin: -3, amplitudeMax: 5 });
  expect(service.commit(captured)).toMatchObject({
    changed: true,
    zoom: { left: -0.007, right: 0.013, bottom: -3, top: 5, use: true },
  });
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit.mock.calls[0][0]).toEqual(['left']);
  expect(edit.mock.calls[0][2]).toEqual({ synchronizeLinks: false });
  const after = store.getState();
  expect(after.past).toHaveLength(1);
  expect(after.documents.right).toEqual(before.right);
  expect(after.documents.left.presets[0].channels[0]).toEqual(before.left.presets[0].channels[0]);
  expect(after.documents.left.presets[0].channels[1]).toEqual({
    ...before.left.presets[0].channels[1],
    hfdImpulseZoom: { left: -0.007, right: 0.013, bottom: -3, top: 5, use: true },
  });
  expect(after.documents.left.presets[0].channels[1].hfdMeasurement).toBeUndefined();
  store.getState().undo();
  expect(store.getState().documents).toEqual(before);
});

it('acknowledges its own committed tuple without resetting history or notifying passive subscribers and treats repeated clicks as document no-ops', async () => {
  const { service, plots, store, edit } = await setup();
  service.restore();
  const binding = service.capture();
  zoom(plots);
  const view = plots.getSnapshot(),
    listener = vi.fn();
  plots.subscribe(listener);
  service.commit(binding);
  expect(service.restore()).toMatchObject({ changed: false, reason: 'unchanged' });
  expect(plots.getSnapshot()).toBe(view);
  expect(plots.getSnapshot().left.Impulse.canReverse).toBe(true);
  expect(listener).not.toHaveBeenCalled();
  const revision = store.getState().documentRevision;
  expect(service.commit(service.capture()).changed).toBe(false);
  expect(store.getState().documentRevision).toBe(revision);
  expect(edit).toHaveBeenCalledTimes(1);
  expect(() => service.commit(binding)).toThrow(/fresh/);
});

for (const changed of [
  'role',
  'preset',
  'channel',
  'channel identity',
  'document revision',
] as const)
  it(`refuses a stale ${changed} before any native zoom write`, async () => {
    const { store, service, edit } = await setup(),
      captured = service.capture();
    if (changed === 'role') store.getState().choose({ slot: 'right' });
    if (changed === 'preset') store.getState().choose({ preset: 1 });
    if (changed === 'channel') store.getState().choose({ channel: 1 });
    if (changed === 'channel identity') {
      const documents = structuredClone(store.getState().documents);
      documents.left.presets[0].channels[0].id = 'replacement-channel';
      store.setState({ documents });
    }
    if (changed === 'document revision') store.setState({ documentRevision: 8 });
    const before = store.getState();
    expect(() => service.commit(captured)).toThrow(/target changed/);
    expect(store.getState().documents).toBe(before.documents);
    expect(store.getState().past).toBe(before.past);
    expect(edit).not.toHaveBeenCalled();
  });

it('reprojects a changed canonical tuple after Undo/import without editing it or coupling Step', async () => {
  const { store, plots, service, edit } = await setup();
  store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom = { ...saved };
  service.restore();
  const binding = service.capture();
  zoom(plots);
  service.commit(binding);
  service.restore();
  const step = plots.getSnapshot().left.Step;
  store.getState().undo();
  const before = store.getState(),
    result = service.restore();
  expect(result).toMatchObject({
    changed: true,
    tupleChanged: true,
    bindingChanged: false,
    restored: true,
  });
  expect(plots.getSnapshot().left.Impulse.range.timeMinMs).toBe(-3);
  expect(plots.getSnapshot().left.Step).toBe(step);
  expect(store.getState().documents).toBe(before.documents);
  expect(edit).toHaveBeenCalledTimes(1);
  const imported = newProject('Imported');
  imported.presets[0].channels[0].hfdImpulseZoom = { ...saved, right: 0.25 };
  store.getState().replaceAt('left', imported);
  expect(service.restore()).toMatchObject({ changed: true, bindingChanged: true, restored: true });
  expect(plots.getSnapshot().left.Impulse.range.timeMaxMs).toBe(250);
  expect(plots.getSnapshot().left.Step).toBe(step);
});

it('an explicit same-identity import can force projection without mistaking an own commit for an import', async () => {
  const { store, service, plots, edit } = await setup();
  store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom = { ...saved };
  service.restore();
  const imported = structuredClone(store.getState().documents.left);
  plots.update(context, { timeMinMs: -100, timeMaxMs: 100 });
  store.getState().replaceAt('left', imported);
  const before = store.getState(),
    step = plots.getSnapshot().left.Step;
  expect(service.restore({ force: true })).toMatchObject({
    restored: true,
    changed: true,
    bindingChanged: false,
    tupleChanged: false,
  });
  expect(plots.getSnapshot().left.Impulse.range).toMatchObject({ timeMinMs: -3, timeMaxMs: 12.5 });
  expect(plots.getSnapshot().left.Step).toBe(step);
  expect(store.getState().documents).toBe(before.documents);
  expect(store.getState().past).toBe(before.past);
  expect(edit).not.toHaveBeenCalled();
});

it('invalidating explicit replacements is inert until later Impulse activation, even with identical stored IDs and bounds', async () => {
  const { store, service, plots, edit } = await setup();
  store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom = { ...saved };
  service.restore();
  store.getState().choose({ slot: 'right' });
  expect(service.restore().changed).toBe(true);
  store.getState().choose({ slot: 'left' });
  plots.update(context, { timeMinMs: -100, timeMaxMs: 100 });
  const before = plots.getSnapshot(),
    documents = store.getState().documents;
  service.invalidate(['left']);
  expect(plots.getSnapshot()).toBe(before);
  expect(store.getState().documents).toBe(documents);
  expect(service.restore()).toMatchObject({ restored: true, changed: true, bindingChanged: true });
  expect(plots.getSnapshot().left.Impulse.range.timeMinMs).toBe(-3);
  store.getState().choose({ slot: 'right' });
  expect(service.restore()).toMatchObject({ changed: false, reason: 'unchanged' });
  expect(edit).not.toHaveBeenCalled();
});

it('unrenderable finite native bounds return invalid during passive restoration without altering raw metadata or any viewport', async () => {
  const { store, service, plots, edit } = await setup(),
    raw = { ...saved, top: Number.MAX_VALUE, bottom: -Number.MAX_VALUE };
  store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom = raw;
  const before = plots.getSnapshot();
  expect(service.restore()).toMatchObject({ restored: false, changed: true, reason: 'invalid' });
  expect(plots.getSnapshot()).toBe(before);
  expect(store.getState().documents.left.presets[0].channels[0].hfdImpulseZoom).toBe(raw);
  expect(edit).not.toHaveBeenCalled();
});
