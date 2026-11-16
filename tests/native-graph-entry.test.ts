import { expect, it, vi } from 'vitest';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  createNativeGraphEntryController,
  type NativeGraphEntryPlan,
} from '../src/application/native-graph-entry';

function fixture(linked = false) {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  for (const [role, project] of Object.entries(documents)) {
    project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
    project.hfdGainLowered = true;
    project.presets.forEach((preset, p) =>
      preset.channels.forEach((channel, c) => {
        channel.gain = p * 3 + c;
        channel.filters.forEach((filter, f) =>
          Object.assign(filter, {
            gain: f / 10,
            frequency: 100 + f,
            enabled: f % 2 === 0,
            coefficients: { b0: 1, b1: f / 100, b2: 0, f1: 0, f2: 0 },
            provenance: role === 'left' ? 'hfd' : 'panel',
          }),
        );
        channel.coefficientCache = c === 1 ? 'unresolved' : 'effective';
      }),
    );
    const channel = project.presets[0].channels[1];
    channel.gain = linked ? 0 : 24;
    channel.additionalGain = linked ? 6 : 10;
    channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: true };
    if (linked) channel.linkedTo = 0;
  }
  let state = { documents, documentRevision: 7 };
  const history: (typeof documents)[] = [];
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
const selected = (f: ReturnType<typeof fixture>, role: Slot = 'left') =>
  f.state().documents[role].presets[0].channels[1];

it('V49 independent first view plans Gain24 to14, unloaded mic clear and explicit group2 without touching source', () => {
  const f = fixture(),
    before = structuredClone(f.state()),
    plan = f.controller.plan({ ...f.request, explicitChannelSelection: true });
  expect(plan).toMatchObject({
    fresh: true,
    changed: true,
    patch: { gain: 14, applyMicCorrection: false, hfdSelectedGroupId: 2 },
  });
  expect(f.state()).toEqual(before);
  expect(f.history).toHaveLength(0);
  expect(Object.isFrozen(plan.patch)).toBe(true);
  f.publish(plan);
  const after = f.state().documents;
  expect(selected(f).gain).toBe(14);
  expect(selected(f).additionalGain).toBe(10);
  expect(selected(f).hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(after.left.hfdSelectedGroupId).toBe(2);
  expect(after.right).toEqual(before.documents.right);
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      expect(after.left.presets[p].channels[c].filters).toEqual(
        before.documents.left.presets[p].channels[c].filters,
      );
      expect(after.left.presets[p].channels[c].coefficientCache).toBe(
        before.documents.left.presets[p].channels[c].coefficientCache,
      );
      if (p !== 0 || c !== 1)
        expect(after.left.presets[p].channels[c]).toEqual(
          before.documents.left.presets[p].channels[c],
        );
    }
  expect(f.history).toHaveLength(1);
});
it('automatic entry preserves selectedgroup-1 and leaves an unopened target unchanged', () => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  const plan = f.controller.plan({ ...f.request, channelIndex: 0 });
  expect(plan.patch).toEqual({});
  f.publish(plan);
  expect(f.state().documents).toEqual(before);
  expect(f.state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(selected(f).gain).toBe(24);
  expect(selected(f).hfdMeasurement!.applyMicCorrection).toBe(true);
  expect(f.controller.plan(f.request).fresh).toBe(true);
});
it('V50 linked first view keeps cached Gain0 and all processing caches while Additional6 becomes10', () => {
  const f = fixture(true),
    before = structuredClone(f.state().documents),
    plan = f.controller.plan({ ...f.request, explicitChannelSelection: true });
  expect(plan.patch).toEqual({
    additionalGain: 10,
    applyMicCorrection: false,
    hfdSelectedGroupId: 2,
  });
  f.publish(plan);
  expect(selected(f)).toMatchObject({ gain: 0, additionalGain: 10, linkedTo: 0 });
  expect(f.state().documents.left.presets[0].channels[0]).toEqual(
    before.left.presets[0].channels[0],
  );
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++)
      expect(f.state().documents.left.presets[p].channels[c].filters).toEqual(
        before.left.presets[p].channels[c].filters,
      );
  expect(f.state().documents.right).toEqual(before.right);
});
it('source linked store guard preserves off-grid cached Gain even though detached callback formatting would round it', () => {
  const f = fixture(true);
  selected(f).gain = 1.23456789;
  f.state().documents.left.hfdGainLowered = false;
  const plan = f.controller.plan(f.request);
  expect(plan.patch.gain).toBeUndefined();
  expect(plan.patch.hfdGainLowered).toBe(true);
  f.publish(plan);
  expect(selected(f).gain).toBe(1.23456789);
  expect(selected(f).additionalGain).toBe(10);
});
it.each([undefined, 0])(
  'zero/absent compensation %s does not synthesize checkbox callback or hint normalization',
  (offset) => {
    const f = fixture();
    selected(f).additionalGain = offset;
    selected(f).hfdMeasurement!.applyMicCorrection = false;
    f.state().documents.left.hfdGainLowered = false;
    const plan = f.controller.plan(f.request);
    expect(plan.patch).toEqual({});
    f.publish(plan);
    expect(selected(f).gain).toBe(24);
    expect(f.state().documents.left.hfdGainLowered).toBe(false);
    expect(f.history).toHaveLength(0);
  },
);
it.each([6, -6])(
  'source nonzero compensation %s follows admitted checkbox normalization only on first entry',
  (offset) => {
    const f = fixture();
    selected(f).additionalGain = offset;
    const plan = f.controller.plan(f.request);
    f.publish(plan);
    expect(selected(f).additionalGain).toBe(10);
    expect(selected(f).gain).toBe(14);
    expect(f.controller.plan(f.request)).toMatchObject({ fresh: false, changed: false });
  },
);
it.each(['absent', 'unresolved-loaded'] as const)(
  'does not clear native apply flag for %s microphone metadata',
  (kind) => {
    const f = fixture();
    if (kind === 'absent') delete f.state().documents.left.hfdCalibration;
    else f.state().documents.left.hfdCalibration!.loaded = true;
    const plan = f.controller.plan(f.request);
    expect(plan.patch.applyMicCorrection).toBeUndefined();
    f.publish(plan);
    expect(selected(f).hfdMeasurement!.applyMicCorrection).toBe(true);
  },
);
it('does not create missing native measurement options on a legacy channel', () => {
  const f = fixture();
  delete selected(f).hfdMeasurement;
  f.publish(f.controller.plan(f.request));
  expect(selected(f).hfdMeasurement).toBeUndefined();
});
it('revisit is inert; explicit channel-selection metadata remains independent of the constructor', () => {
  const f = fixture();
  f.publish(f.controller.plan(f.request));
  const before = structuredClone(f.state().documents),
    revision = f.state().documentRevision;
  f.publish(f.controller.plan(f.request));
  expect(f.state().documents).toEqual(before);
  expect(f.state().documentRevision).toBe(revision);
  const selection = f.controller.plan({ ...f.request, explicitChannelSelection: true });
  expect(selection).toMatchObject({ fresh: false, patch: { hfdSelectedGroupId: 2 } });
  f.publish(selection);
  expect(selected(f).gain).toBe(14);
  expect(f.state().documents.left.hfdSelectedGroupId).toBe(2);
});
it('successful canonical no-op still publishes view/selection and claims one visit without history', () => {
  const f = fixture();
  selected(f).gain = 14;
  selected(f).hfdMeasurement!.applyMicCorrection = false;
  const first = f.controller.plan(f.request),
    competing = f.controller.plan(f.request),
    publish = vi.fn();
  expect(first).toMatchObject({ fresh: true, changed: false });
  f.controller.commit(first, publish);
  expect(publish).toHaveBeenCalledOnce();
  expect(f.history).toHaveLength(0);
  expect(f.controller.plan(f.request).fresh).toBe(false);
  expect(() => f.controller.commit(competing, publish)).toThrow(/changed/);
});
it('failed publication and discarded dummy proposals claim nothing', () => {
  const f = fixture(),
    original = structuredClone(f.state());
  expect(() =>
    f.controller.commit(f.controller.plan(f.request), () => {
      throw Error('refused');
    }),
  ).toThrow('refused');
  expect(f.controller.plan(f.request).fresh).toBe(true);
  expect(() =>
    f.controller.commit(f.controller.plan(f.request), (apply) =>
      apply(structuredClone(f.state().documents.left), 'left'),
    ),
  ).toThrow(/not published/);
  expect(f.state()).toEqual(original);
  expect(f.controller.plan(f.request).fresh).toBe(true);
});
it.each(['revision', 'project', 'generation'] as const)(
  'rejects a stale %s before invoking the publisher',
  (kind) => {
    const f = fixture(),
      plan = f.controller.plan(f.request),
      publish = vi.fn();
    if (kind === 'revision') f.set({ ...f.state(), documentRevision: 8 });
    if (kind === 'project')
      f.set({ ...f.state(), documents: structuredClone(f.state().documents) });
    if (kind === 'generation') f.controller.invalidateRoles(['left']);
    expect(() => f.controller.commit(plan, publish)).toThrow(/changed/);
    expect(publish).not.toHaveBeenCalled();
    expect(f.controller.plan(f.request).fresh).toBe(true);
  },
);
it('synchronous invalidation between admission and detached apply refuses before any proposed mutation', () => {
  const f = fixture(),
    plan = f.controller.plan(f.request),
    draft = structuredClone(f.state().documents.left),
    before = structuredClone(draft);
  expect(() =>
    f.controller.commit(plan, (apply) => {
      f.controller.invalidateRoles(['left']);
      apply(draft, 'left');
    }),
  ).toThrow(/changed/);
  expect(draft).toEqual(before);
  expect(f.controller.plan(f.request).fresh).toBe(true);
});
it('apply refuses original store objects, wrong roles and changed cache/provenance before touching the proposal', () => {
  for (const kind of ['original', 'role', 'cache'] as const) {
    const f = fixture(),
      plan = f.controller.plan(f.request),
      draft =
        kind === 'original' ? f.state().documents.left : structuredClone(f.state().documents.left);
    if (kind === 'cache') draft.presets[0].channels[1].filters[0].provenance = 'panel';
    const before = structuredClone(draft);
    expect(() =>
      f.controller.commit(plan, (apply) => apply(draft, kind === 'role' ? 'right' : 'left')),
    ).toThrow(/detached/);
    expect(draft).toEqual(before);
  }
});
it('independent role/preset/channel lifetimes do not infer identity from duplicate native IDs', () => {
  const f = fixture();
  f.state().documents.right.presets[0].channels[1].id = selected(f).id;
  f.publish(f.controller.plan(f.request));
  expect(f.controller.plan({ ...f.request, slot: 'right' }).fresh).toBe(true);
  expect(f.controller.plan({ ...f.request, presetIndex: 1 }).fresh).toBe(true);
  f.controller.invalidateRoles(['right']);
  expect(f.controller.plan(f.request).fresh).toBe(false);
  f.controller.invalidateRoles(['left']);
  expect(f.controller.plan(f.request).fresh).toBe(true);
});
it('forged plans, invalid roles and async publications cannot create visit authority', () => {
  const f = fixture(),
    publish = vi.fn();
  expect(() => f.controller.commit({ ...f.controller.plan(f.request) }, publish)).toThrow(
    /Unknown/,
  );
  expect(publish).not.toHaveBeenCalled();
  expect(() => f.controller.invalidateRoles(['left', 'left'])).toThrow();
  expect(f.controller.plan(f.request).fresh).toBe(true);
  expect(() =>
    f.controller.commit(f.controller.plan(f.request), async () => {
      throw Error('async refused');
    }),
  ).toThrow(/synchronous/);
  expect(f.controller.plan(f.request).fresh).toBe(true);
});
it('real workspace Undo/Redo restores exact data without replaying initialization', async () => {
  let saved: unknown = null;
  const f = fixture(),
    store = createWorkspaceStore({
      read: async () => saved,
      write: async (value) => {
        saved = structuredClone(value);
      },
      readLegacy: () => null,
    });
  await store.persistence.hydrate();
  store.store.setState({
    documents: f.state().documents,
    past: [],
    future: [],
    gesture: undefined,
  });
  const current = store.store.getState,
    controller = createNativeGraphEntryController({ current }),
    before = structuredClone(current().documents),
    plan = controller.plan({ ...f.request, explicitChannelSelection: true });
  controller.commit(plan, (apply) =>
    current().editAt([plan.slot], (project, slot) => apply(project, slot), {
      synchronizeLinks: false,
    }),
  );
  const after = structuredClone(current().documents);
  expect(current().past).toHaveLength(1);
  current().undo();
  expect(current().documents).toEqual(before);
  const revisit = controller.plan(f.request);
  expect(revisit).toMatchObject({ fresh: false, changed: false });
  controller.commit(revisit, () => {});
  expect(current().documents).toEqual(before);
  current().redo();
  expect(current().documents).toEqual(after);
  expect(current().past).toHaveLength(1);
  await store.persistence.flush();
});
