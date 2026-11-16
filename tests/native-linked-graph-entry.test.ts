import { expect, it, vi } from 'vitest';
import { newFilter, newProject } from '../src/domain/model';
import { designHfd } from '../src/domain/hfd-math';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { captureNativeCacheWitness, validNativeCacheWitness } from '../src/domain/native-cache';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  createNativeGraphEntryController,
  type NativeGraphEntryPlan,
} from '../src/application/native-graph-entry';
import { prepareNativeProjectOpen } from '../src/application/native-project-open';

function project() {
  const value = newProject('Synthetic immediate linked Graph');
  value.hfdSelectedPreset = 1;
  value.hfdSelectedGroupId = 2;
  value.hfdCalibration = { filename: '', loaded: false, showCurve: false };
  const [source, target] = value.presets[0].channels;
  source.gain = -3;
  source.additionalGain = 10;
  source.coefficientCache = 'base';
  source.filters[0] = {
    ...newFilter('peak'),
    frequency: 2300,
    q: 1.15,
    gain: 7.5,
    enabled: true,
    provenance: 'hfd',
    sourceId: '13',
  };
  source.filters[0].coefficients = designHfd(source.filters[0]);
  Object.assign(target, {
    gain: 24,
    additionalGain: 0,
    invert: true,
    muted: true,
    delayUs: 1,
    linkedTo: 0,
    coefficientCache: 'unresolved',
    hfdMeasurement: { ...defaultHfdMeasurementOptions(), applyMicCorrection: true },
  });
  target.filters[0].coefficients = { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 };
  target.filters[0].provenance = 'hfd';
  target.filters[0].sourceId = '72';
  return value;
}
function fixture() {
  let state = { documents: { left: project(), right: project() }, documentRevision: 7 };
  const history: (typeof state.documents)[] = [];
  const controller = createNativeGraphEntryController({ current: () => state });
  const request = { slot: 'left' as const, presetIndex: 0, channelIndex: 1 };
  const publish = (plan: NativeGraphEntryPlan) =>
    controller.commit(plan, (apply) => {
      if (!plan.changed) return;
      const documents = structuredClone(state.documents);
      apply(documents[plan.slot], plan.slot);
      history.push(state.documents);
      state = { documents, documentRevision: state.documentRevision + 1 };
    });
  return {
    controller,
    request,
    publish,
    history,
    state: () => state,
    set: (next: typeof state) => {
      state = next;
    },
  };
}
const channel = (f: ReturnType<typeof fixture>, index = 1) =>
  f.state().documents.left.presets[0].channels[index];

it('explicit linked Graph copies only the immediate selected destination in one detached publication', () => {
  const f = fixture(),
    before = structuredClone(f.state()),
    plan = f.controller.planGraphOpen({ ...f.request, explicitChannelSelection: true });
  expect(f.state()).toEqual(before);
  expect(plan).toMatchObject({ fresh: true, changed: true });
  f.publish(plan);
  expect(channel(f)).toMatchObject({
    gain: -3,
    additionalGain: 0,
    invert: false,
    muted: false,
    delayUs: 0,
    linkedTo: 0,
    coefficientCache: 'base',
  });
  expect(channel(f).filters[0]).toMatchObject({
    kind: 'peak',
    frequency: 2300,
    q: 1.15,
    gain: 7.5,
    sourceId: '72',
    id: before.documents.left.presets[0].channels[1].filters[0].id,
  });
  expect(channel(f).filters[0].coefficients).toEqual(channel(f, 0).filters[0].coefficients);
  expect(channel(f).hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(channel(f, 0)).toEqual(before.documents.left.presets[0].channels[0]);
  expect(f.state().documents.left.presets.slice(1)).toEqual(before.documents.left.presets.slice(1));
  expect(f.state().documents.right).toEqual(before.documents.right);
  expect(f.history).toHaveLength(1);
});

it('ordinary graph refresh does not copy, and a later explicit opening still copies after the cold visit', () => {
  const f = fixture(),
    filters = structuredClone(channel(f).filters);
  f.publish(f.controller.plan(f.request));
  expect(channel(f).filters).toEqual(filters);
  expect(channel(f).gain).toBe(24);
  const plan = f.controller.planGraphOpen(f.request);
  expect(plan).toMatchObject({ fresh: false, changed: true });
  f.publish(plan);
  expect(channel(f).gain).toBe(-3);
  expect(channel(f).filters[0].kind).toBe('peak');
});

it('copying an immediate linked source does not flatten its chain or refresh that intermediate channel', () => {
  const f = fixture();
  channel(f).gain = 8;
  channel(f).filters[0].kind = 'raw';
  channel(f).filters[0].coefficients = { b0: 0.625, b1: 0.125, b2: 0, f1: 0.25, f2: 0 };
  channel(f, 2).linkedTo = 1;
  channel(f, 2).additionalGain = 0;
  const before = structuredClone(f.state().documents);
  f.publish(f.controller.planGraphOpen({ ...f.request, channelIndex: 2 }));
  expect(channel(f, 2).gain).toBe(8);
  expect(channel(f, 2).filters[0].coefficients).toEqual(
    before.left.presets[0].channels[1].filters[0].coefficients,
  );
  expect(channel(f, 2).coefficientCache).toBe('unresolved');
  expect(channel(f)).toEqual(before.left.presets[0].channels[1]);
  expect(channel(f, 0)).toEqual(before.left.presets[0].channels[0]);
});

it('cold AdditionalGain normalization settles effective raw cache only inside the admitted copy', () => {
  const f = fixture(),
    source = channel(f, 0),
    scalar = 10 ** (7 / 20),
    base = source.filters[0].coefficients!;
  const raw = { ...base, b0: base.b0 * scalar, b1: base.b1 * scalar, b2: base.b2 * scalar };
  source.coefficientCache = 'effective';
  source.filters[0].coefficients = {
    ...raw,
    b0: raw.b0 / scalar,
    b1: raw.b1 / scalar,
    b2: raw.b2 / scalar,
  };
  source.hfdDirectCacheWitness = captureNativeCacheWitness(source, raw);
  channel(f).additionalGain = 6;
  const beforeSource = structuredClone(source);
  f.publish(f.controller.planGraphOpen(f.request));
  expect(channel(f)).toMatchObject({ gain: -3, additionalGain: 10, coefficientCache: 'effective' });
  expect(validNativeCacheWitness(channel(f))!.native).toEqual(raw);
  expect(channel(f).filters[0].coefficients).toEqual(source.filters[0].coefficients);
  expect(channel(f, 0)).toEqual(beforeSource);
});

it.each(['sourceGain', 'sourceCache', 'sourceFir', 'targetCache', 'sourceXml'] as const)(
  'rejects in-place %s changes before invoking the publisher',
  (kind) => {
    const f = fixture(),
      plan = f.controller.planGraphOpen(f.request),
      publish = vi.fn();
    if (kind === 'sourceGain') channel(f, 0).gain = -2;
    if (kind === 'sourceCache') channel(f, 0).filters[0].coefficients!.b0 += 0.01;
    if (kind === 'sourceFir') channel(f, 0).fir.taps = [1, 0.25];
    if (kind === 'targetCache') channel(f).filters[0].coefficients!.b1 += 0.01;
    if (kind === 'sourceXml') f.state().documents.left.sourceXml = '<changed />';
    const before = structuredClone(f.state());
    expect(() => f.controller.commit(plan, publish)).toThrow(/changed/);
    expect(publish).not.toHaveBeenCalled();
    expect(f.state()).toEqual(before);
    expect(f.controller.planGraphOpen(f.request).fresh).toBe(true);
  },
);

it('a wrong-role detached proposal is refused before any copy or visit is claimed', () => {
  const f = fixture(),
    plan = f.controller.planGraphOpen(f.request),
    draft = structuredClone(f.state().documents.left),
    before = structuredClone(draft);
  expect(() => f.controller.commit(plan, (apply) => apply(draft, 'right'))).toThrow(/detached/);
  expect(draft).toEqual(before);
  expect(f.controller.planGraphOpen(f.request).fresh).toBe(true);
});

it('native Open prepares auto-Graph copying before publication; its posthook is a no-op visit claim', () => {
  const input = project(),
    before = structuredClone(input),
    prepared = prepareNativeProjectOpen(input, 'left', { presetIndex: 0, route: 'inner' });
  expect(input).toEqual(before);
  expect(prepared.project.presets[0].channels[1]).toMatchObject({
    gain: -3,
    additionalGain: 0,
    invert: false,
    muted: false,
    delayUs: 0,
    coefficientCache: 'base',
  });
  const documents = { left: prepared.project, right: project() },
    controller = createNativeGraphEntryController({
      current: () => ({ documents, documentRevision: 8 }),
    }),
    plan = controller.planNativeFileOpen(
      { slot: 'left', presetIndex: 0, channelIndex: 1 },
      'inner',
    );
  expect(plan).toMatchObject({ fresh: true, changed: false });
  controller.commit(plan, () => {});
  expect(controller.plan({ slot: 'left', presetIndex: 0, channelIndex: 1 }).fresh).toBe(false);
});

it('Undo restores exact stale linked data; another explicit opening recopies without replaying cold callbacks', async () => {
  const workspace = createWorkspaceStore({
    read: async () => null,
    write: async () => {},
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  workspace.store.setState({
    documents: { left: project(), right: project() },
    past: [],
    future: [],
    gesture: undefined,
  });
  const current = workspace.store.getState,
    before = structuredClone(current().documents),
    controller = createNativeGraphEntryController({ current }),
    request = { slot: 'left' as const, presetIndex: 0, channelIndex: 1 },
    publish = (plan: NativeGraphEntryPlan) =>
      controller.commit(plan, (apply) => {
        if (plan.changed)
          current().editAt(['left'], (document, slot) => apply(document, slot), {
            synchronizeLinks: false,
          });
      });
  publish(controller.planGraphOpen(request));
  expect(current().past).toHaveLength(1);
  current().undo();
  expect(current().documents).toEqual(before);
  const plan = controller.planGraphOpen(request);
  expect(plan).toMatchObject({ fresh: false, changed: true });
  publish(plan);
  expect(current().documents.left.presets[0].channels[1]).toMatchObject({
    gain: -3,
    hfdMeasurement: { applyMicCorrection: true },
  });
  expect(current().documents.right).toEqual(before.right);
  expect(current().past).toHaveLength(1);
  const after = structuredClone(current().documents),
    revision = current().documentRevision;
  const noop = controller.planGraphOpen(request);
  expect(noop.changed).toBe(false);
  publish(noop);
  expect(current().documents).toEqual(after);
  expect(current().documentRevision).toBe(revision);
  expect(current().past).toHaveLength(1);
});
