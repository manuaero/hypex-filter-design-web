import { expect, it, vi } from 'vitest';
import { newProject } from '../src/domain/model';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { createNativeGraphEntryController } from '../src/application/native-graph-entry';

function fixture(loaded?: boolean) {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  for (const project of Object.values(documents)) {
    project.hfdSelectedGroupId = 2;
    if (loaded !== undefined) project.hfdCalibration = { loaded, filename: '', showCurve: false };
    const channel = project.presets[0].channels[1];
    channel.gain = 24;
    channel.additionalGain = 10;
    channel.coefficientCache = 'effective';
    channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: false };
    channel.filters[0].coefficients = { b0: 1, b1: 0.1, b2: 0, f1: 0, f2: 0 };
    channel.filters[0].provenance = 'hfd';
  }
  let state = { documents, documentRevision: 3 };
  const controller = createNativeGraphEntryController({ current: () => state });
  const request = { slot: 'left' as const, presetIndex: 0, channelIndex: 1 };
  const publish = (plan: ReturnType<typeof controller.plan>) =>
    controller.commit(plan, (apply) => {
      if (!plan.changed) return;
      const next = structuredClone(state.documents);
      apply(next[plan.slot], plan.slot);
      state = { documents: next, documentRevision: state.documentRevision + 1 };
    });
  return {
    controller,
    request,
    publish,
    state: () => state,
    set: (next: typeof state) => {
      state = next;
    },
  };
}

it('dialog Native Open publishes selected microphone true when a loaded resource is recorded', () => {
  const f = fixture(true),
    before = structuredClone(f.state().documents);
  const plan = f.controller.planNativeFileOpen(f.request, 'dialog');
  expect(plan.patch).toEqual({ gain: 14, hfdGainLowered: true, applyMicCorrection: true });
  expect(f.state().documents).toEqual(before);
  f.publish(plan);
  const channel = f.state().documents.left.presets[0].channels[1];
  expect(channel).toMatchObject({ gain: 14, additionalGain: 10 });
  expect(channel.hfdMeasurement!.applyMicCorrection).toBe(true);
  expect(channel.filters).toEqual(before.left.presets[0].channels[1].filters);
  expect(channel.coefficientCache).toBe('effective');
  expect(f.state().documents.left.hfdSelectedGroupId).toBe(2);
  expect(f.state().documents.right).toEqual(before.right);
});

it.each([false, true, undefined])(
  'dialog selected microphone final state follows explicit unloaded metadata %s',
  (loaded) => {
    const f = fixture(loaded);
    delete f.state().documents.left.presets[0].channels[1].hfdMeasurement;
    const plan = f.controller.planNativeFileOpen(f.request, 'dialog');
    expect(plan.patch.applyMicCorrection).toBe(loaded !== false);
    f.publish(plan);
    expect(f.state().documents.left.presets[0].channels[1].hfdMeasurement).toEqual({
      ...defaultHfdMeasurementOptions(),
      applyMicCorrection: loaded !== false,
    });
  },
);

it('inner Open keeps ordinary constructor microphone rules instead of adding dialog postbinding', () => {
  const f = fixture(true);
  const plan = f.controller.planNativeFileOpen(f.request, 'inner');
  expect(plan.patch.applyMicCorrection).toBeUndefined();
  f.publish(plan);
  expect(f.state().documents.left.presets[0].channels[1].hfdMeasurement!.applyMicCorrection).toBe(
    false,
  );
});

it('V50 linked Native Open preserves cached Gain while normalizing nonzero compensation', () => {
  const f = fixture(false),
    channel = f.state().documents.left.presets[0].channels[1];
  channel.linkedTo = 0;
  channel.gain = 0;
  channel.additionalGain = 6;
  const before = structuredClone(channel);
  f.publish(f.controller.planNativeFileOpen(f.request, 'dialog'));
  expect(f.state().documents.left.presets[0].channels[1]).toEqual({
    ...before,
    additionalGain: 10,
  });
  expect(f.state().documents.left.hfdGainLowered).toBe(true);
});

it('Native Open requires an unused role generation, while ordinary view revisits stay available', () => {
  const f = fixture(false);
  f.publish(f.controller.plan({ ...f.request, channelIndex: 0 }));
  expect(() => f.controller.planNativeFileOpen(f.request, 'dialog')).toThrow(/fresh|generation/i);
  expect(f.controller.plan(f.request).fresh).toBe(true);
  f.controller.invalidateRoles(['left']);
  f.publish(f.controller.planNativeFileOpen(f.request, 'dialog'));
  expect(() => f.controller.planNativeFileOpen(f.request, 'dialog')).toThrow(/fresh|generation/i);
});

it('fresh Native Open plans retain generation, revision and explicit role fences', () => {
  for (const change of ['revision', 'generation', 'role'] as const) {
    const f = fixture(false),
      plan = f.controller.planNativeFileOpen(f.request, 'dialog'),
      publish = vi.fn();
    if (change === 'revision') f.set({ ...f.state(), documentRevision: 4 });
    if (change === 'generation') f.controller.invalidateRoles(['left']);
    if (change !== 'role') {
      expect(() => f.controller.commit(plan, publish)).toThrow(/changed/);
      expect(publish).not.toHaveBeenCalled();
    } else {
      const draft = structuredClone(f.state().documents.left),
        before = structuredClone(draft);
      expect(() => f.controller.commit(plan, (apply) => apply(draft, 'right'))).toThrow(
        /role|detached/i,
      );
      expect(draft).toEqual(before);
    }
  }
});

it('an intervening no-op visit retires pending Native Open authority even without a document revision', () => {
  const f = fixture(false),
    plan = f.controller.planNativeFileOpen(f.request, 'dialog'),
    publish = vi.fn();
  const revision = f.state().documentRevision;
  f.publish(f.controller.plan({ ...f.request, channelIndex: 0 }));
  expect(f.state().documentRevision).toBe(revision);
  expect(() => f.controller.commit(plan, publish)).toThrow(/changed/);
  expect(publish).not.toHaveBeenCalled();
});

it('dialog-specific semantics cannot be supplied as extra ordinary request flags', () => {
  const f = fixture(false);
  expect(() => f.controller.plan({ ...f.request, route: 'dialog' } as never)).toThrow(/request/);
  expect(() =>
    f.controller.planNativeFileOpen(
      { ...f.request, explicitChannelSelection: true } as never,
      'dialog',
    ),
  ).toThrow(/request/);
  expect(() => f.controller.planNativeFileOpen(f.request, 'other' as never)).toThrow(
    /route|request/,
  );
});

it('a canonical Native Open no-op claims its role generation without a document mutation', () => {
  const f = fixture(false),
    channel = f.state().documents.left.presets[0].channels[1];
  channel.gain = 14;
  f.state().documents.left.hfdGainLowered = true;
  const before = f.state(),
    plan = f.controller.planNativeFileOpen(f.request, 'dialog');
  expect(plan.changed).toBe(false);
  f.publish(plan);
  expect(f.state()).toBe(before);
  expect(() => f.controller.planNativeFileOpen(f.request, 'dialog')).toThrow(/fresh|generation/i);
});
