import { describe, expect, it, vi } from 'vitest';
import { newProject, type Channel } from '../src/domain/model';
import { createGraphViewController, type GraphViewContext } from '../src/application/graph-view';

const load = (channel: Channel, kind: 'impulse' | 'spectrum' = 'spectrum') => {
  channel.measurement = {
    name: 'fixture',
    sampleRate: 48000,
    ...(kind === 'impulse'
      ? { impulse: [0, 1] }
      : { frequency: [10, 1000], magnitude: [0, -3], phase: [0, 0] }),
  };
};
function fixture() {
  const channels = newProject().presets[0].channels;
  channels.forEach((channel) => load(channel));
  return {
    slot: 'left',
    channels,
    channelIndex: 0,
    binding: 'project:preset1',
  } satisfies GraphViewContext;
}

describe('staged role-local graph view', () => {
  it('has independent frozen browser defaults and stable snapshots until commit', () => {
    const controller = createGraphViewController(),
      snapshot = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(snapshot.left).toEqual({
      sum: true,
      measured: false,
      rawMeasurements: [false, false, false],
      currentResult: true,
      otherResults: true,
      section: false,
      sectionScope: 'selected',
      nativeTracking: false,
      phase: { channels: [false, false, false], sum: false },
    });
    expect(snapshot.left).not.toBe(snapshot.right);
    expect(snapshot.left.rawMeasurements).not.toBe(snapshot.right.rawMeasurements);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.left.rawMeasurements)).toBe(true);
  });
  it('plans are inert, detached and discardable even when native flag writeback is required', () => {
    const controller = createGraphViewController(),
      context = fixture();
    context.channels[0].hfdGraph = { showMeasuredResponse: false, showSum: false };
    const before = structuredClone(context),
      snapshot = controller.getSnapshot(),
      raw = [true, false, false],
      plan = controller.plan(context, { rawMeasurements: raw, sum: true });
    raw[0] = false;
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(context).toEqual(before);
    expect(plan.next.rawMeasurements[0]).toBe(true);
    expect(plan.writeback).toEqual({ showMeasuredResponse: true, showSum: true });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.writeback)).toBe(true);
    expect(Object.isFrozen(plan.next)).toBe(true);
    expect(plan.binding).toBe(context.binding);
    expect(plan.channelId).toBe(context.channels[0].id);
    // A failed document edit simply discards this plan; no compensating mutation.
    expect(controller.getSnapshot()).toBe(snapshot);
  });
  it('commits once, notifies once, and preserves the other role object and plans', () => {
    const controller = createGraphViewController(),
      context = fixture(),
      notify = vi.fn(),
      unsubscribe = controller.subscribe(notify),
      initial = controller.getSnapshot(),
      left = controller.plan(context, { section: true }),
      right = controller.plan({ ...context, slot: 'right' }, { measured: true });
    expect(controller.commit(left)).toBe(left.next);
    expect(controller.getSnapshot().right).toBe(initial.right);
    controller.commit(right);
    expect(controller.getSnapshot().left.section).toBe(true);
    expect(controller.getSnapshot().right.measured).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(() => controller.commit(left)).toThrow(/stale/);
    unsubscribe();
    controller.commit(controller.plan(context, { section: false }));
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('refuses stale, forged and foreign plans without view changes', () => {
    const controller = createGraphViewController(),
      context = fixture(),
      first = controller.plan(context, { section: true }),
      stale = controller.plan(context, { measured: true });
    controller.commit(first);
    const before = controller.getSnapshot();
    expect(() => controller.commit(stale)).toThrow(/stale/);
    expect(() => controller.commit({ ...first })).toThrow(/belong/);
    const foreign = createGraphViewController().plan(context, { sum: false });
    expect(() => controller.commit(foreign)).toThrow(/belong/);
    expect(controller.getSnapshot()).toBe(before);
  });
  it('consumes no-op selection plans without publishing a new external-store snapshot', () => {
    const controller = createGraphViewController(),
      context = fixture(),
      notify = vi.fn();
    // Initial native selection checks the current phase box. A repeated
    // selection remains a true no-op after that view-only initialization.
    controller.commit(controller.selection(context, { normalize: false }));
    controller.subscribe(notify);
    const initial = controller.getSnapshot(),
      stale = controller.plan(context, { section: true }),
      selection = controller.selection(context, { normalize: false });
    expect(controller.commit(selection)).toBe(initial.left);
    expect(controller.getSnapshot()).toBe(initial);
    expect(notify).not.toHaveBeenCalled();
    expect(() => controller.commit(stale)).toThrow(/stale/);
    expect(() => controller.commit(selection)).toThrow(/stale/);
  });
  it('rejects every requested unloaded raw overlay before changing view or document', () => {
    const controller = createGraphViewController(),
      context = fixture();
    context.channels[2].measurement = undefined;
    const before = structuredClone(context),
      snapshot = controller.getSnapshot();
    expect(() =>
      controller.plan(context, { measured: true, rawMeasurements: [true, false, true] }),
    ).toThrow(/Load/);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(context).toEqual(before);
    load(context.channels[2], 'impulse');
    expect(
      controller.plan(context, { rawMeasurements: [false, false, true] }).next.rawMeasurements[2],
    ).toBe(true);
  });
  it('validates context, strict patches and raw arrays instead of partial updates', () => {
    const controller = createGraphViewController(),
      context = fixture();
    for (const channelIndex of [-1, 3, 0.5, NaN])
      expect(() => controller.plan({ ...context, channelIndex }, {})).toThrow(/context/);
    expect(() => controller.plan(context, { rawMeasurements: [true] })).toThrow(/selection/);
    expect(() => controller.plan(context, { sectionScope: 'bad' as never })).toThrow(/scope/);
    expect(() => controller.plan(context, { sum: 1 as never })).toThrow(/toggle/);
    expect(() => controller.plan(context, { nativeTracking: true } as never)).toThrow(/Unknown/);
  });
});

describe('native saved flags and temporary overlays', () => {
  it('HFD preset restores selected raw/sum, retaining other raw boxes and ordinary independent prefs', () => {
    const controller = createGraphViewController(),
      context = fixture();
    controller.commit(controller.plan(context, { rawMeasurements: [false, true, false] }));
    context.channels[0].hfdGraph = { showMeasuredResponse: true, showSum: false };
    const plan = controller.plan(context, { preset: 'hfd' });
    expect(plan.next).toEqual({
      sum: false,
      measured: true,
      rawMeasurements: [true, true, false],
      currentResult: true,
      otherResults: false,
      section: true,
      sectionScope: 'selected',
      nativeTracking: true,
      phase: { channels: [false, false, false], sum: false },
    });
    expect(plan.writeback).toBeUndefined();
    controller.commit(plan);
    const outputs = controller.plan(context, { preset: 'outputs' });
    expect(outputs.next).toMatchObject({
      sum: false,
      measured: true,
      rawMeasurements: [true, true, false],
      currentResult: true,
      otherResults: true,
      section: false,
      nativeTracking: false,
    });
    expect(outputs.writeback).toBeUndefined();
  });
  it('current raw and sum save only under a native marker/tracking; other raw and presentation never persist', () => {
    const controller = createGraphViewController(),
      context = fixture();
    expect(
      controller.plan(context, { rawMeasurements: [true, false, false], sum: false }).writeback,
    ).toBeUndefined();
    context.channels[0].hfdGraph = { showMeasuredResponse: false, showSum: true };
    expect(
      controller.plan(context, {
        rawMeasurements: [false, true, false],
        measured: true,
        section: true,
        otherResults: false,
      }).writeback,
    ).toBeUndefined();
    expect(controller.plan(context, { rawMeasurements: [true, true, false] }).writeback).toEqual({
      showMeasuredResponse: true,
      showSum: true,
    });
    expect(controller.plan(context, { sum: false }).writeback).toEqual({
      showMeasuredResponse: false,
      showSum: false,
    });
    context.channels[0].hfdGraph = undefined;
    controller.commit(controller.plan(context, { preset: 'hfd' }));
    expect(controller.plan(context, { sum: true }).writeback).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
  });
  it('selection restores one native checkbox, leaves noncurrent runtime boxes and legacy browser views alone', () => {
    const controller = createGraphViewController(),
      context = fixture();
    controller.commit(
      controller.plan(context, { rawMeasurements: [true, true, false], sum: true }),
    );
    expect(
      controller.selection({ ...context, channelIndex: 2 }, { normalize: false }).next
        .rawMeasurements,
    ).toEqual([true, true, false]);
    context.channels[1].hfdGraph = { showMeasuredResponse: false, showSum: false };
    const plan = controller.selection({ ...context, channelIndex: 1 }, { normalize: false });
    expect(plan.next.rawMeasurements).toEqual([true, false, false]);
    expect(plan.next.sum).toBe(false);
    expect(plan.writeback).toBeUndefined();
    controller.commit(plan);
    const returnPlan = controller.selection(context, { normalize: false });
    expect(returnPlan.next.rawMeasurements).toEqual([true, false, false]);
    expect(returnPlan.next.sum).toBe(false);
  });
  it('passive restore hides stale raw without mutation; explicit selection/HFD preset proposes native normalization', () => {
    const controller = createGraphViewController(),
      context = fixture();
    context.channels[0].measurement = undefined;
    context.channels[0].hfdGraph = { showMeasuredResponse: true, showSum: true };
    const before = structuredClone(context);
    const passive = controller.selection(context, { normalize: false });
    expect(passive.next.rawMeasurements[0]).toBe(false);
    expect(passive.writeback).toBeUndefined();
    expect(controller.selection(context, { normalize: true }).writeback).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
    expect(controller.plan(context, { preset: 'hfd' }).writeback).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
    expect(context).toEqual(before);
  });
  it('filter/cascade selection adjusts scope without unexpectedly enabling its overlay', () => {
    const controller = createGraphViewController(),
      context = fixture();
    const whole = controller.selection(context, { normalize: false, selectSection: false });
    expect(whole.next).toMatchObject({ section: false, sectionScope: 'channel' });
    controller.commit(whole);
    const selected = controller.selection(context, { normalize: false, selectSection: true });
    expect(selected.next).toMatchObject({ section: false, sectionScope: 'selected' });
    controller.commit(controller.plan(context, { preset: 'hfd' }));
    expect(
      controller.selection(context, { normalize: false, selectSection: false }).next,
    ).toMatchObject({ section: true, sectionScope: 'channel' });
  });
});
