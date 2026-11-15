import { expect, it } from 'vitest';
import {
  createGraphViewController,
  phaseCurveAvailable,
  type GraphViewContext,
} from '../src/application/graph-view';
import { newProject } from '../src/domain/model';

function fixture() {
  const channels = newProject().presets[0].channels;
  channels.forEach((channel, i) => {
    channel.measurement = { name: `driver${i}`, sampleRate: 48000, impulse: [0, 1] };
  });
  return {
    slot: 'left',
    channels,
    channelIndex: 0,
    binding: 'project:preset1',
  } satisfies GraphViewContext;
}

it('starts with native unchecked phase boxes/sum and independently frozen role state', () => {
  const controller = createGraphViewController(),
    initial = controller.getSnapshot();
  expect(initial.left.phase).toEqual({ channels: [false, false, false], sum: false });
  expect(initial.left.phase).not.toBe(initial.right.phase);
  expect(initial.left.phase.channels).not.toBe(initial.right.phase.channels);
  expect(Object.isFrozen(initial.left.phase.channels)).toBe(true);
  expect(controller.getSnapshot()).toBe(initial);
});
it('selection checks only the current phase curve without changing any channel processing or sum membership', () => {
  const context = fixture(),
    before = structuredClone(context),
    controller = createGraphViewController();
  context.channels[1].includeInSum = false;
  before.channels[1].includeInSum = false;
  const plan = controller.selection(context, { normalize: false });
  expect(plan.next.phase).toEqual({ channels: [true, false, false], sum: false });
  expect(plan.writeback).toBeUndefined();
  expect(controller.getSnapshot().left.phase.channels).toEqual([false, false, false]);
  controller.commit(plan);
  expect(context).toEqual(before);
});
it('retains other phase boxes across group/preset selection and preserves an explicit same-group uncheck', () => {
  const context = fixture(),
    controller = createGraphViewController();
  controller.commit(controller.selection(context, { normalize: false }));
  controller.commit(controller.selection({ ...context, channelIndex: 1 }, { normalize: false }));
  expect(controller.getSnapshot().left.phase.channels).toEqual([true, true, false]);
  const selected = { ...context, channelIndex: 1 };
  controller.commit(
    controller.plan(selected, { phase: { channels: [true, false, false], sum: true } }),
  );
  controller.commit(controller.selection(selected, { normalize: false }));
  expect(controller.getSnapshot().left.phase).toEqual({
    channels: [true, false, false],
    sum: true,
  });
  controller.commit(
    controller.selection({ ...selected, binding: 'project:preset2' }, { normalize: false }),
  );
  expect(controller.getSnapshot().left.phase).toEqual({ channels: [true, true, false], sum: true });
});
it('keeps phase sum independent from magnitude/time sum and each role', () => {
  const context = fixture(),
    controller = createGraphViewController();
  const right = controller.getSnapshot().right;
  controller.commit(controller.plan(context, { phase: { sum: true }, sum: false }));
  expect(controller.getSnapshot().left.phase.sum).toBe(true);
  expect(controller.getSnapshot().left.sum).toBe(false);
  expect(controller.getSnapshot().right).toBe(right);
  controller.commit(controller.plan(context, { sum: true }));
  expect(controller.getSnapshot().left.phase.sum).toBe(true);
  controller.commit(controller.plan(context, { phase: { sum: false } }));
  expect(controller.getSnapshot().left.sum).toBe(true);
});
it('explicit measurement Load/Clear refresh rechecks current in the same binding without model writeback', () => {
  const context = fixture(),
    before = structuredClone(context),
    controller = createGraphViewController();
  controller.commit(controller.selection(context, { normalize: false }));
  controller.commit(
    controller.plan(context, { phase: { channels: [false, true, false], sum: true } }),
  );
  controller.commit(controller.selection(context, { normalize: false }));
  expect(controller.getSnapshot().left.phase.channels).toEqual([false, true, false]);
  const plan = controller.selection(context, { normalize: false, refreshPhase: true });
  expect(controller.getSnapshot().left.phase.channels).toEqual([false, true, false]);
  expect(plan.writeback).toBeUndefined();
  controller.commit(plan);
  expect(controller.getSnapshot().left.phase).toEqual({
    channels: [true, true, false],
    sum: true,
  });
  expect(context).toEqual(before);
  expect(controller.getSnapshot().right.phase).toEqual({
    channels: [false, false, false],
    sum: false,
  });
  const snapshot = controller.getSnapshot();
  expect(() =>
    controller.selection(context, { normalize: false, refreshPhase: 1 } as never),
  ).toThrow('Invalid graph view selection');
  expect(controller.getSnapshot()).toBe(snapshot);
});
it('preserves an unavailable selected checkbox while refusing user visibility changes to unloaded channels', () => {
  const context = fixture(),
    controller = createGraphViewController();
  delete context.channels[0].measurement;
  const plan = controller.selection(context, { normalize: false });
  controller.commit(plan);
  expect(controller.getSnapshot().left.phase.channels).toEqual([true, false, false]);
  expect(phaseCurveAvailable(context.channels[0])).toBe(false);
  expect(() => controller.plan(context, { phase: { channels: [false, false, false] } })).toThrow(
    'Load a measurement',
  );
  expect(() =>
    controller.plan(context, { phase: { channels: [true, true, false] } }),
  ).not.toThrow();
  controller.commit(controller.plan(context, { phase: { sum: true } }));
  expect(controller.getSnapshot().left.phase.sum).toBe(true);
});
it('does not let an abandoned selection plan change future selection behavior', () => {
  const context = fixture(),
    controller = createGraphViewController();
  controller.selection({ ...context, channelIndex: 2 }, { normalize: false });
  controller.commit(controller.selection(context, { normalize: false }));
  expect(controller.getSnapshot().left.phase.channels).toEqual([true, false, false]);
});
it('owns detached phase selections and rejects stale/forged plans before notification', () => {
  const context = fixture(),
    controller = createGraphViewController(),
    selected = [true, true, false];
  const plan = controller.plan(context, { phase: { channels: selected, sum: true } });
  selected[1] = false;
  expect(plan.next.phase.channels).toEqual([true, true, false]);
  controller.commit(plan);
  expect(() => controller.commit(plan)).toThrow('stale');
  expect(() => controller.commit({ ...plan })).toThrow('stale');
  expect(Object.isFrozen(controller.getSnapshot().left.phase)).toBe(true);
});
it.each([
  { channels: [] },
  { channels: [true, false] },
  { channels: [true, false, 1] },
  { channels: 'all' },
  { sum: 1 },
  { channels: [true, false, false], includeInSum: true },
  null,
  [],
])('rejects malformed phase state without changing either view or documents: %j', (phase) => {
  const context = fixture(),
    before = structuredClone(context),
    controller = createGraphViewController();
  const snapshot = controller.getSnapshot();
  expect(() => controller.plan(context, { phase } as never)).toThrow();
  expect(controller.getSnapshot()).toBe(snapshot);
  expect(context).toEqual(before);
});
