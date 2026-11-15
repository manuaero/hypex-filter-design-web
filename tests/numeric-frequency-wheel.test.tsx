// @vitest-environment jsdom
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Numeric from '../src/components/Numeric';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function field() {
  return host.querySelector<HTMLInputElement>('input')!;
}

it('keeps continuous decimal typing live and discards a focused draft after an external value replacement', async () => {
  const changed = vi.fn();
  let replace!: (next: number) => void;
  function Controlled() {
    const [value, setValue] = useState(1000);
    replace = setValue;
    return (
      <Numeric
        label="Frequency"
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        contextKey="left:one:filter-one"
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  await act(async () => field().focus());
  await enter('1');
  await enter('1.');
  expect(field().value).toBe('1.');
  await enter('1.25');
  expect(field().value).toBe('1.25');
  expect(changed).toHaveBeenLastCalledWith(1.25);
  await act(async () => replace(870));
  expect(field().value).toBe('870');
  const calls = changed.mock.calls.length;
  await act(async () => field().blur());
  expect(changed).toHaveBeenCalledTimes(calls);
});

it('drops a pending draft when the role or explicit project replacement context changes', async () => {
  const changed = vi.fn();
  await act(async () =>
    root.render(
      <Numeric
        label="Frequency"
        value={1000}
        onChange={changed}
        contextKey="left:filter-one:0"
        commitOnly
      />,
    ),
  );
  await act(async () => field().focus());
  await enter('430');
  await act(async () =>
    root.render(
      <Numeric
        label="Frequency"
        value={1200}
        onChange={changed}
        contextKey="right:filter-one:1"
        commitOnly
      />,
    ),
  );
  expect(field().value).toBe('1200');
  await act(async () => field().blur());
  expect(changed).not.toHaveBeenCalled();
});
async function wheel(deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => field().dispatchEvent(event));
  return event;
}
async function key(key: string) {
  await act(async () =>
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
  );
}
async function enter(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render(value = 1000, extra: Partial<ComponentProps<typeof Numeric>> = {}) {
  const changed = vi.fn();
  function Controlled() {
    const [current, setCurrent] = useState(value);
    return (
      <Numeric
        label="Frequency"
        value={current}
        min={1}
        max={50000}
        frequencyWheel="input-eq"
        {...extra}
        onChange={(next) => {
          changed(next);
          setCurrent(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  return changed;
}

it('uses direction-specific input EQ steps, ignores wheel magnitude, and prevents inspector scrolling', async () => {
  const changed = await render();
  expect((await wheel(-1)).defaultPrevented).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(1100);
  await wheel(120);
  expect(changed).toHaveBeenLastCalledWith(1000);
  await wheel(1);
  expect(changed).toHaveBeenLastCalledWith(990);
  expect(field().value).toBe('990');
  expect(changed).toHaveBeenCalledTimes(3);
});

it('retains comma drafts and existing manual precision without snapping, while keyboard arrows keep their explicit fixed step', async () => {
  const changed = await render(999.9, { step: 0.25 });
  await act(async () => field().focus());
  await enter('999,9');
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(1009.9);
  expect(field().value).toBe('1009.9');
  await key('ArrowDown');
  expect(changed).toHaveBeenLastCalledWith(1009.65);
  await act(async () => field().blur());
  expect(field().value).toBe('1009.65');
});

it('clamps the resulting value to caller bounds and ignores zero vertical movement and disabled controls', async () => {
  const changed = await render(9999, { max: 10000 });
  await wheel(-1);
  expect(changed).toHaveBeenLastCalledWith(10000);
  await wheel(-120);
  expect(changed).toHaveBeenCalledTimes(1);
  expect((await wheel(0)).defaultPrevented).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      <Numeric label="Locked" value={1000} onChange={changed} disabled frequencyWheel="input-eq" />,
    ),
  );
  expect((await wheel(-120)).defaultPrevented).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('keeps commit-only focus gating and ordinary fixed-step controls unchanged', async () => {
  const changed = await render(1000, { commitOnly: true });
  expect((await wheel(-120)).defaultPrevented).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  await act(async () => field().focus());
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(1100);
  await act(async () =>
    root.render(<Numeric label="Q" value={1} step={0.01} onChange={changed} />),
  );
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(1.01);
});

it('groups focused comma editing and multiple wheel adjustments into one complete workspace Undo/Redo transaction', async () => {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  documents.left.presets[0].inputEq[0].frequency = 1000;
  let envelope: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const { store, persistence } = createWorkspaceStore({
    read: async () => structuredClone(envelope),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(envelope, expected, next);
      envelope = structuredClone(next);
    },
  });
  await persistence.hydrate();
  const before = structuredClone(store.getState().documents);
  function Connected() {
    const state = store();
    return (
      <Numeric
        label="Frequency"
        value={state.documents.left.presets[0].inputEq[0].frequency}
        frequencyWheel="input-eq"
        begin={state.beginGesture}
        end={state.endGesture}
        onChange={(frequency) =>
          state.editAt(['left'], (project) => {
            project.presets[0].inputEq[0].frequency = frequency;
          })
        }
      />
    );
  }
  await act(async () => root.render(<Connected />));
  await act(async () => field().focus());
  await enter('999,9');
  await wheel(-120);
  await wheel(120);
  expect(store.getState().past).toHaveLength(0);
  expect(store.getState().documents.left.presets[0].inputEq[0].frequency).toBe(909.9);
  await act(async () => field().blur());
  expect(store.getState().past).toHaveLength(1);
  const after = structuredClone(store.getState().documents);
  await act(async () => store.getState().undo());
  expect(store.getState().documents).toEqual(before);
  await act(async () => store.getState().redo());
  expect(store.getState().documents).toEqual(after);
  expect(store.getState().documents.right).toEqual(before.right);
  await persistence.flush();
});

it('advanced mode displays native precision without editing imported canonical data until a wheel event commits a Single value', async () => {
  const changed = await render(1000.125, { frequencyWheel: 'advanced' });
  expect(field().value).toBe('1000.1');
  expect(changed).not.toHaveBeenCalled();
  expect((await wheel(-120)).defaultPrevented).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(1068.199951171875);
  expect(field().value).toBe('1068.2');
  await wheel(1);
  expect(field().value).toBe('998.2');
  expect(changed).toHaveBeenCalledTimes(2);
});

it('advanced mode accepts its configured native step and retains browser manual comma drafts and fixed keyboard steps', async () => {
  const changed = await render(1000, {
    frequencyWheel: 'advanced',
    frequencyWheelStep: 250,
    step: 0.25,
  });
  await wheel(-1);
  expect(changed).toHaveBeenLastCalledWith(1045.699951171875);
  expect(field().value).toBe('1045.7');
  await act(async () => field().focus());
  await enter('1234,567');
  expect(changed).toHaveBeenLastCalledWith(1234.567);
  expect(field().value).toBe('1234,567');
  await key('ArrowUp');
  expect(changed).toHaveBeenLastCalledWith(1234.817);
  expect(field().value).toBe('1234.8');
});

it('advanced mode keeps zero/disabled/focus gates and caller bounds without input EQ decade increments', async () => {
  const changed = await render(1000, { frequencyWheel: 'advanced', max: 1050, commitOnly: true });
  expect((await wheel(-120)).defaultPrevented).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  await act(async () => field().focus());
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(1050);
  expect(field().value).toBe('1050.0');
  await wheel(-1);
  expect(changed).toHaveBeenCalledOnce();
  expect((await wheel(0)).defaultPrevented).toBe(false);
  await act(async () =>
    root.render(
      <Numeric label="Locked" value={1000} onChange={changed} frequencyWheel="advanced" disabled />,
    ),
  );
  expect((await wheel(-1)).defaultPrevented).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
});

it('an underflowed zero native delta retains an imported canonical value, and changing display mode alone never commits it', async () => {
  const changed = vi.fn();
  await act(async () =>
    root.render(
      <Numeric label="Frequency" value={1000.125} onChange={changed} frequencyWheel="input-eq" />,
    ),
  );
  expect(field().value).toBe('1000.125');
  await act(async () =>
    root.render(
      <Numeric
        label="Frequency"
        value={1000.125}
        onChange={changed}
        frequencyWheel="advanced"
        frequencyWheelStep={1e308}
      />,
    ),
  );
  expect(field().value).toBe('1000.1');
  await wheel(-120);
  expect(changed).not.toHaveBeenCalled();
  expect(field().value).toBe('1000.1');
});

it('uses separate graph-dependent wheel bounds without clamping imported data on render or changing manual/keyboard bounds', async () => {
  const changed = await render(1000.125, {
    frequencyWheel: 'advanced',
    min: 1,
    max: 50000,
    frequencyWheelMin: 10,
    frequencyWheelMax: 500,
  });
  expect(field().value).toBe('1000.1');
  expect(changed).not.toHaveBeenCalled();
  await wheel(-1);
  expect(changed).toHaveBeenLastCalledWith(500);
  expect(field().value).toBe('500.0');
  await key('ArrowUp');
  expect(changed).toHaveBeenLastCalledWith(501);
  await act(async () => field().focus());
  await enter('2,5');
  expect(changed).toHaveBeenLastCalledWith(2.5);
  await wheel(120);
  expect(changed).toHaveBeenLastCalledWith(10);
});

it('retains the native Single result after a manual draft followed by a wheel and blur', async () => {
  const changed = await render(1000, { frequencyWheel: 'advanced' });
  await act(async () => field().focus());
  await enter('1234,567');
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(1309.199951171875);
  expect(field().value).toBe('1309.2');
  const count = changed.mock.calls.length;
  await act(async () => field().blur());
  expect(changed).toHaveBeenCalledTimes(count);
  expect(changed).toHaveBeenLastCalledWith(1309.199951171875);
});

it('advanced wheel edits form one complete source-project Undo/Redo and cancelled gesture while the other project stays exact', async () => {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  documents.left.presets[0].channels[0].filters[0].frequency = 1000.125;
  let envelope: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const { store, persistence } = createWorkspaceStore({
    read: async () => structuredClone(envelope),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(envelope, expected, next);
      envelope = structuredClone(next);
    },
  });
  await persistence.hydrate();
  const before = structuredClone(store.getState().documents);
  function Connected() {
    const state = store();
    return (
      <Numeric
        label="Frequency"
        value={state.documents.left.presets[0].channels[0].filters[0].frequency}
        frequencyWheel="advanced"
        begin={state.beginGesture}
        end={state.endGesture}
        onChange={(frequency) =>
          state.editAt(['left'], (project) => {
            project.presets[0].channels[0].filters[0].frequency = frequency;
          })
        }
      />
    );
  }
  await act(async () => root.render(<Connected />));
  expect(store.getState().documents).toEqual(before);
  await act(async () => field().focus());
  await wheel(-1);
  await wheel(-120);
  expect(store.getState().past).toHaveLength(0);
  expect(field().value).toBe('1138.2');
  await act(async () => field().blur());
  expect(store.getState().past).toHaveLength(1);
  const after = structuredClone(store.getState().documents);
  expect(after.right).toEqual(before.right);
  await act(async () => store.getState().undo());
  expect(store.getState().documents).toEqual(before);
  await act(async () => store.getState().redo());
  expect(store.getState().documents).toEqual(after);
  await act(async () => field().focus());
  await wheel(-1);
  await key('Escape');
  expect(store.getState().documents).toEqual(after);
  expect(store.getState().past).toHaveLength(1);
  await persistence.flush();
});
