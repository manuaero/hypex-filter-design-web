// @vitest-environment jsdom
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Numeric from '../src/components/Numeric';
import { normalizeHfdManualFrequencyText } from '../src/domain/manual-frequency';
import {
  normalizeHfdManualQText,
  normalizeHfdManualGainText,
  formatHfdManualQValue,
  formatHfdManualGainValue,
} from '../src/domain/manual-parameter';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';
import { HFD_INPUT_EQ_PROFILE } from '../src/domain/input-eq-parameters';

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

it.each([
  ['frequency', 400, '10.35', 10.4, '10.4'],
  ['q', 0.7, '0.4005', 0.401, '0.401'],
  ['gain', 7.5, '7.555', 7.56, '7.56'],
] as const)(
  'Input EQ %s commits local Text as its fixed-profile Double',
  async (parameter, initial, text, expected, shown) => {
    const profile = HFD_INPUT_EQ_PROFILE[parameter];
    const changed = await render(initial, {
      inputEqParameter: parameter,
      frequencyWheel: undefined,
      min: profile.min,
      max: profile.max,
    });
    await act(async () => field().focus());
    await enter(text);
    expect(field().value).toBe(text);
    expect(changed).not.toHaveBeenCalled();
    await key('Enter');
    expect(changed).toHaveBeenCalledExactlyOnceWith(expected);
    expect(expected).not.toBe(Math.fround(expected));
    expect(field().value).toBe(shown);
  },
);

it.each([
  ['frequency', 100, 110, 100, 99],
  ['q', 0.7, 0.74, 0.7, 0.66],
  ['gain', 15.85, 15.9, 15.8, 15.7],
] as const)(
  'Input EQ %s wheel uses the full profile once per event without channel AdditionalGain',
  async (parameter, initial, up, down, again) => {
    const profile = HFD_INPUT_EQ_PROFILE[parameter];
    const changed = await render(initial, {
      inputEqParameter: parameter,
      frequencyWheel: undefined,
      min: profile.min,
      max: profile.max,
      parameterWheelAdditionalGain: 10,
    });
    expect((await wheel(-360)).defaultPrevented).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(up);
    expect((await wheel(0)).defaultPrevented).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    await wheel(120);
    expect(changed).toHaveBeenLastCalledWith(down);
    await wheel(1);
    expect(changed).toHaveBeenLastCalledWith(again);
    expect(host.textContent).not.toContain('Stored');
  },
);

it('Input EQ passive formatting preserves imported precision and resets wheel state after external replacement', async () => {
  const changed = vi.fn();
  let replace!: (value: number) => void;
  function Controlled() {
    const [value, setValue] = useState(20.000001);
    replace = setValue;
    return (
      <Numeric
        label="Input EQ Q"
        value={value}
        inputEqParameter="q"
        contextKey="left:eq1"
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  expect(field().value).toBe('20.000');
  await act(async () => field().focus());
  await act(async () => field().blur());
  expect(changed).not.toHaveBeenCalled();
  await wheel(-120);
  expect(changed).not.toHaveBeenCalled();
  await act(async () => replace(1.3));
  await wheel(120);
  expect(changed).toHaveBeenCalledExactlyOnceWith(1.26);
  await act(async () => field().focus());
  await enter('not finite');
  await act(async () => field().blur());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(field().value).toBe('1.260');
});

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

it.each([
  ['1', 10, '10.0'],
  ['10.35', Math.fround(10.4), '10.4'],
  ['400,04', 400, '400.0'],
  ['50001', 50000, '50000.0'],
  ['0', 720, '720.0'],
])(
  'defers native manual Text %s until blur, then commits its decimal/Single value',
  async (text, expected, shown) => {
    const changed = await render(720, {
      min: 10,
      max: 50000,
      frequencyWheel: 'advanced',
      deferTextCommit: true,
      normalizeText: (raw, previousValue) =>
        normalizeHfdManualFrequencyText(raw, { previousValue }),
    });
    await act(async () => field().focus());
    await enter(text);
    expect(field().value).toBe(text);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => field().blur());
    if (expected === 720) expect(changed).not.toHaveBeenCalled();
    else expect(changed).toHaveBeenCalledExactlyOnceWith(expected);
    expect(field().value).toBe(shown);
  },
);

it('defers invalid manual text without gating hover wheel, preserves its Single result on blur, and cancels Escape', async () => {
  const changed = await render(1000, {
    min: 10,
    max: 50000,
    frequencyWheel: 'advanced',
    frequencyWheelMin: 10,
    frequencyWheelMax: 40000,
    deferTextCommit: true,
    normalizeText: (raw, previousValue) => normalizeHfdManualFrequencyText(raw, { previousValue }),
  });
  await wheel(-120);
  expect(changed).toHaveBeenCalledExactlyOnceWith(1068.0999755859375);
  await act(async () => field().focus());
  await enter('10.35');
  await key('Escape');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(field().value).toBe('1068.1');
  await act(async () => field().focus());
  await enter('not finite');
  await act(async () => field().blur());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(field().value).toBe('1068.1');
});

it.each([
  ['q', '0.4005', 0.401, '0.401'],
  ['q', '0', 0.7, '0.700'],
  ['q', '-1', 0.1, '0.100'],
  ['q', '99', 20, '20.000'],
  ['gain', '7.555', 7.56, '7.56'],
  ['gain', '0', 0, '0.00'],
  ['gain', '-126', -125, '-125.00'],
  ['gain', '25', 24, '24.00'],
])(
  'commits ordinary %s raw Text %s once as a bounded Double',
  async (kind, text, expected, shown) => {
    const q = kind === 'q';
    const changed = await render(q ? 0.7 : 3, {
      frequencyWheel: undefined,
      deferTextCommit: true,
      normalizeText: (raw, previousValue) =>
        (q ? normalizeHfdManualQText : normalizeHfdManualGainText)(raw, { previousValue }),
      formatValue: q ? formatHfdManualQValue : formatHfdManualGainValue,
    });
    await act(async () => field().focus());
    await enter(text);
    expect(changed).not.toHaveBeenCalled();
    expect(field().value).toBe(text);
    await key('Enter');
    if (q && text === '0') expect(changed).not.toHaveBeenCalled();
    else expect(changed).toHaveBeenCalledExactlyOnceWith(expected);
    expect(field().value).toBe(shown);
    if (text === '0.4005' || text === '7.555') expect(expected).not.toBe(Math.fround(expected));
  },
);

it('formats imported Q/gain passively without committing on focus/blur or cancelled text', async () => {
  const changed = await render(0.456789123456789, {
    frequencyWheel: undefined,
    deferTextCommit: true,
    normalizeText: (raw, previousValue) => normalizeHfdManualQText(raw, { previousValue }),
    formatValue: formatHfdManualQValue,
  });
  expect(field().value).toBe('0.457');
  await act(async () => field().focus());
  await act(async () => field().blur());
  expect(changed).not.toHaveBeenCalled();
  await act(async () => field().focus());
  await enter('1.0005');
  await key('Escape');
  expect(changed).not.toHaveBeenCalled();
  expect(field().value).toBe('0.457');
});

it('keeps generic wheel/arrow bounds separate from ordinary typed Q/gain limits', async () => {
  const changed = await render(20, {
    frequencyWheel: undefined,
    min: 0.1,
    max: 20,
    step: 0.01,
    adjustmentBounds: { min: 0.001, max: 100 },
    deferTextCommit: true,
    normalizeText: (raw, previousValue) => normalizeHfdManualQText(raw, { previousValue }),
    formatValue: formatHfdManualQValue,
  });
  await key('ArrowUp');
  expect(changed).toHaveBeenLastCalledWith(20.01);
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(20.020000000000003);
  await act(async () => field().focus());
  await enter('99');
  await act(async () => field().blur());
  expect(changed).toHaveBeenLastCalledWith(20);
});

it('native Q wheel ignores magnitude/zero, prevents scroll and remains separate from legacy arrows', async () => {
  const changed = await render(0.7, {
    frequencyWheel: undefined,
    parameterWheel: 'q',
    step: 0.01,
    min: 0.1,
    max: 20,
    adjustmentBounds: { min: 0.001, max: 100 },
    deferTextCommit: true,
    formatValue: formatHfdManualQValue,
    normalizeText: (raw, previousValue) => normalizeHfdManualQText(raw, { previousValue }),
  });
  expect((await wheel(-1)).defaultPrevented).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(0.74);
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(0.78);
  const count = changed.mock.calls.length;
  expect((await wheel(0)).defaultPrevented).toBe(false);
  expect(changed).toHaveBeenCalledTimes(count);
  await key('ArrowUp');
  expect(changed).toHaveBeenLastCalledWith(0.79);
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(0.83);
  expect(field().value).toBe('0.830');
});

it('native bound events retain imported precision and dirty Text rejects without a canonical edit', async () => {
  const changed = await render(20.00001, {
    frequencyWheel: undefined,
    parameterWheel: 'q',
    min: 0.1,
    max: 20,
    deferTextCommit: true,
    formatValue: formatHfdManualQValue,
  });
  expect(field().value).toBe('20.000');
  await wheel(-120);
  await wheel(-1);
  expect(changed).not.toHaveBeenCalled();
  await wheel(120);
  expect(changed).toHaveBeenCalledExactlyOnceWith(19.96);
  await act(async () => field().focus());
  await enter('NAN');
  await wheel(-120);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(field().value).toBe('19.960');
});

it('native gain wheel uses AdditionalGain and resets private state after external/context changes', async () => {
  const changed = vi.fn();
  let replace!: (next: number) => void;
  function Controlled() {
    const [value, setValue] = useState(20);
    replace = setValue;
    return (
      <Numeric
        label="Gain"
        value={value}
        parameterWheel="gain"
        parameterWheelAdditionalGain={10}
        min={-125}
        max={24}
        deferTextCommit
        formatValue={formatHfdManualGainValue}
        contextKey="gain-left"
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(20.1);
  expect(field().value).toBe('14.00');
  await act(async () => replace(7.5));
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(7.6);
  await wheel(120);
  expect(changed).toHaveBeenLastCalledWith(7.5);
});

it('retains guarded native gain Text on its own unfocused model acknowledgement and shows the stored value', async () => {
  const changed = vi.fn();
  function Controlled() {
    const [value, setValue] = useState(17.95);
    return (
      <Numeric
        label="Gain"
        unit="dB"
        value={value}
        parameterWheel="gain"
        parameterWheelAdditionalGain={10}
        min={-125}
        max={24}
        deferTextCommit
        formatValue={formatHfdManualGainValue}
        contextKey="gain-left"
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  expect(document.activeElement).not.toBe(field());
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(18.05);
  expect(field().value).toBe('14.00');
  expect(host.textContent).toContain('Stored 18.05 dB');
  await wheel(-360);
  expect(changed).toHaveBeenLastCalledWith(14.1);
  expect(field().value).toBe('14.00');
  expect(host.textContent).toContain('Stored 14.10 dB');
  await wheel(120);
  expect(changed).toHaveBeenLastCalledWith(13.9);
  expect(field().value).toBe('13.90');
  expect(host.textContent).not.toContain('Stored');
});

it('discards guarded gain Text and its private state on blur, external value and context replacement', async () => {
  const changed = vi.fn();
  let replace!: (next: number) => void, context!: (next: string) => void;
  function Controlled() {
    const [value, setValue] = useState(17.95),
      [key, setKey] = useState('left');
    replace = setValue;
    context = setKey;
    return (
      <Numeric
        label="Gain"
        unit="dB"
        value={value}
        parameterWheel="gain"
        parameterWheelAdditionalGain={10}
        min={-125}
        max={24}
        deferTextCommit
        formatValue={formatHfdManualGainValue}
        contextKey={key}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  await act(async () => field().focus());
  await wheel(-120);
  expect(field().value).toBe('14.00');
  await act(async () => field().blur());
  expect(field().value).toBe('18.05');
  expect(host.textContent).not.toContain('Stored');
  await wheel(120);
  expect(changed).toHaveBeenLastCalledWith(17.95);
  expect(field().value).toBe('14.00');
  await act(async () => replace(7.5));
  expect(field().value).toBe('7.50');
  expect(host.textContent).not.toContain('Stored');
  await wheel(-120);
  expect(changed).toHaveBeenLastCalledWith(7.6);
  await act(async () => replace(17.95));
  await wheel(-120);
  expect(field().value).toBe('14.00');
  await act(async () => context('right'));
  expect(field().value).toBe('18.05');
  expect(host.textContent).not.toContain('Stored');
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
