// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Numeric from '../src/components/Numeric';
import * as delay from '../src/domain/channel-delay';
import { createWorkspaceStore } from '../src/state/workspace';

const local: delay.HfdChannelDelayProfile = Object.freeze({
  kind: 'local',
  unit: 'us',
  sampleRate: 93750,
  minimumText: '0',
  maximumText: '19200',
});
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
  vi.restoreAllMocks();
});
const field = () => host.querySelector<HTMLInputElement>('input')!;
async function enter(text: string, options: { prevented?: boolean; composing?: boolean } = {}) {
  await act(async () => {
    field().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text);
    const event = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: options.composing ? 'insertCompositionText' : 'insertText',
      isComposing: options.composing,
    });
    if (options.prevented) event.preventDefault();
    field().dispatchEvent(event);
  });
}
async function key(key: string) {
  await act(async () =>
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
}
async function wheel(deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => field().dispatchEvent(event));
  return event;
}
async function fixture(
  initial = 0,
  options: {
    coupledText?: boolean;
    coupledWheel?: boolean;
    step?: number;
    callbacks?: boolean;
    publishMaximum?: boolean;
  } = {},
) {
  const workspace = createWorkspaceStore({
    read: async () => null,
    write: async () => {},
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  const current = workspace.store.getState;
  const documents = structuredClone(current().documents);
  documents.left.presets[0].channels[0].delayUs = initial;
  if (options.publishMaximum) documents.left.presets[0].channels[0].hfdDelay = { localMaximum: 19 };
  workspace.store.setState({ documents, past: [], future: [], gesture: undefined });
  let profile = local,
    context = 'left:p1:channel:epoch0',
    rejectWheel = false;
  const value = () => current().documents.left.presets[0].channels[0].delayUs;
  const publish = (next: number, coupled = false) => {
    if (Object.is(next, value()) && !coupled) return;
    current().editAt(
      coupled ? ['left', 'right'] : ['left'],
      (project, slot) => {
        if (slot === 'left') project.presets[0].channels[0].delayUs = next;
        else project.presets[0].channels[0].name = 'Coupled Text notification';
      },
      { synchronizeLinks: false },
    );
  };
  const changed = vi.fn((next: number) => publish(next));
  const raw = vi.fn((text: string): { text: string; value: number } | false => {
    const result = delay.normalizeHfdChannelDelayText(text, { profile });
    if (options.publishMaximum)
      current().editAt(
        ['left'],
        (project) => {
          const channel = project.presets[0].channels[0];
          channel.delayUs = result.value;
          channel.hfdDelay = { ...channel.hfdDelay, localMaximum: result.maximumValue };
        },
        { synchronizeLinks: false },
      );
    else publish(result.value, options.coupledText);
    return result;
  });
  const adjusted = vi.fn((result: delay.HfdChannelDelayWheelResult, _direction: -1 | 1) => {
    if (rejectWheel) return false;
    if (result.changed || (options.coupledWheel && result.notified))
      publish(result.value, options.coupledWheel && result.notified);
    return true;
  });
  function Harness() {
    const state = workspace.store();
    return (
      <Numeric
        label="Delay"
        value={state.documents.left.presets[0].channels[0].delayUs}
        channelDelay={profile}
        channelDelayRevision={state.documentRevision}
        getChannelDelayRevision={() => current().documentRevision}
        contextKey={context}
        min={0}
        max={Number(profile.maximumText)}
        step={options.step ?? 10.6666666667}
        onChange={changed}
        onTextCommit={options.callbacks === false ? undefined : raw}
        onChannelDelayWheel={options.callbacks === false ? undefined : adjusted}
        begin={() => {
          if (current().documents !== state.documents)
            throw new Error('Stale render focus context');
          const token = current().beginFieldGesture();
          return {
            isCurrent: () => current().isFieldGestureCurrent(token),
            run: (action) => current().runFieldGesture(token, action),
            end: (cancel) => current().endFieldGesture(token, cancel),
          };
        }}
      />
    );
  }
  const render = () => root.render(<Harness />);
  await act(async () => render());
  return {
    current,
    value,
    raw,
    changed,
    adjusted,
    render,
    replaceProfile: (next: delay.HfdChannelDelayProfile) => {
      profile = next;
    },
    replaceContext: () => {
      context = 'left:p1:channel:epoch1';
    },
    reject: (value: boolean) => {
      rejectWheel = value;
    },
    foreign: () =>
      current().editAt(
        ['right'],
        (project) => {
          project.presets[0].channels[0].name = 'Accepted foreign edit';
        },
        { independent: true, synchronizeLinks: false },
      ),
  };
}

it.each([
  ['1', 0],
  ['16', 21],
] as const)(
  'forwards original dirty Text%s only at Enter and shows native normalized%d',
  async (text, expected) => {
    const f = await fixture();
    await enter(text);
    expect(f.value()).toBe(0);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    await key('Enter');
    expect(f.raw).toHaveBeenCalledExactlyOnceWith(text);
    expect(f.value()).toBe(expected);
    expect(field().value).toBe(String(expected));
    expect(f.current().past).toHaveLength(expected === 0 ? 0 : 1);
  },
);
it('publishes an explicit selected-value no-op raw intent for coupled peer effects in the owned field transaction', async () => {
  const f = await fixture(0, { coupledText: true }),
    before = structuredClone(f.current().documents);
  await enter('1');
  await key('Enter');
  expect(f.raw).toHaveBeenCalledExactlyOnceWith('1');
  expect(f.value()).toBe(0);
  expect(f.current().documents.right.presets[0].channels[0].name).toBe('Coupled Text notification');
  expect(f.current().past).toHaveLength(1);
  await act(async () => f.current().undo());
  expect(f.current().documents).toEqual(before);
});
it.each(['Enter', 'blur'])(
  'forwards a genuine same-visible-Text input on %s and publishes only its callback maximum',
  async (action) => {
    // Native C00/C01: full-select0/type0/Tab retains Delay0 but Max19->19200.
    const f = await fixture(0, { publishMaximum: true }),
      before = structuredClone(f.current().documents);
    expect(field().value).toBe('0');
    await enter('0');
    expect(f.raw).not.toHaveBeenCalled();
    if (action === 'Enter') await key('Enter');
    else await act(async () => field().blur());
    expect(f.raw).toHaveBeenCalledExactlyOnceWith('0');
    expect(f.value()).toBe(0);
    expect(f.current().documents.left.presets[0].channels[0].hfdDelay?.localMaximum).toBe(19200);
    expect(f.current().documents.right).toEqual(before.right);
    expect(f.current().past).toHaveLength(1);
    await act(async () => f.current().undo());
    expect(f.current().documents).toEqual(before);
  },
);
it.each(['Enter', 'blur'])(
  'does not invoke a same-Text callback on passive focus and %s without input',
  async (action) => {
    const f = await fixture(0, { publishMaximum: true }),
      before = structuredClone(f.current().documents);
    await act(async () => field().focus());
    if (action === 'Enter') await key('Enter');
    else await act(async () => field().blur());
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.current().documents).toEqual(before);
    expect(f.current().past).toHaveLength(0);
  },
);
it('Escape cancels a genuine same-Text input without publishing its callback maximum', async () => {
  const f = await fixture(0, { publishMaximum: true }),
    before = structuredClone(f.current().documents);
  await enter('0');
  await key('Escape');
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.current().documents).toEqual(before);
  expect(f.current().past).toHaveLength(0);
});
it('does not admit an already-prevented input event as dirty same Text', async () => {
  const f = await fixture(0, { publishMaximum: true });
  await enter('0', { prevented: true });
  await key('Enter');
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.current().documents.left.presets[0].channels[0].hfdDelay?.localMaximum).toBe(19);
});
it('keeps composition Enter within the draft and commits completed same Text only at later blur', async () => {
  const f = await fixture(0, { publishMaximum: true });
  await enter('0', { composing: true });
  await act(async () =>
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(field());
  expect(f.raw).not.toHaveBeenCalled();
  await enter('0');
  await act(async () => field().blur());
  expect(f.raw).toHaveBeenCalledExactlyOnceWith('0');
  expect(f.current().documents.left.presets[0].channels[0].hfdDelay?.localMaximum).toBe(19200);
});
it('clears a rejected same-Text input before passive refocus and permits a later genuine input', async () => {
  const f = await fixture(0, { publishMaximum: true });
  f.raw.mockReturnValueOnce(false);
  await enter('0');
  await key('Enter');
  expect(f.raw).toHaveBeenCalledTimes(1);
  expect(f.current().past).toHaveLength(0);
  await act(async () => {
    field().focus();
    field().blur();
  });
  expect(f.raw).toHaveBeenCalledTimes(1);
  await enter('0');
  await key('Enter');
  expect(f.raw).toHaveBeenCalledTimes(2);
  expect(f.current().documents.left.presets[0].channels[0].hfdDelay?.localMaximum).toBe(19200);
  expect(f.current().past).toHaveLength(1);
});
it('retires a same-Text input lease after an accepted foreign command without publishing MaxDelay', async () => {
  const f = await fixture(0, { publishMaximum: true });
  await enter('0');
  await act(async () => f.foreign());
  const accepted = structuredClone(f.current().documents);
  await act(async () => field().blur());
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.current().documents).toEqual(accepted);
  expect(f.current().documents.left.presets[0].channels[0].hfdDelay?.localMaximum).toBe(19);
  expect(f.current().past).toHaveLength(1);
});
it('formats passive Single Text without changing an imported canonical value or notifying', async () => {
  const f = await fixture(0.499999999);
  expect(field().value).toBe('1');
  expect(f.value()).toBe(0.499999999);
  await act(async () => {
    field().focus();
    field().blur();
  });
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.value()).toBe(0.499999999);
});
it.each([-120, -360])(
  'handles one sign-only wheel%d from zero and prevents passive scrolling',
  async (delta) => {
    const f = await fixture();
    expect((await wheel(delta)).defaultPrevented).toBe(true);
    expect(f.value()).toBe(11);
    expect(field().value).toBe('11');
    expect(f.adjusted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ value: 11, notified: true, changed: true, maximumValue: 19200 }),
      1,
    );
    expect(f.current().past).toHaveLength(1);
    expect((await wheel(0)).defaultPrevented).toBe(false);
    expect(f.adjusted).toHaveBeenCalledTimes(1);
  },
);
it('forwards a notified wheel even when its final canonical value is unchanged', async () => {
  const f = await fixture();
  await enter('-10');
  await wheel(-120);
  expect(f.adjusted).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      value: 0,
      text: '0',
      changed: false,
      notified: true,
      maximumValue: 19200,
    }),
    1,
  );
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.value()).toBe(0);
  expect(field().value).toBe('0');
});
it('retains bound no-notification state and own changed acknowledgements, including equivalent profile objects', async () => {
  const spy = vi.spyOn(delay, 'hfdChannelDelayWheelNext'),
    f = await fixture(19200.000001);
  await wheel(-120);
  expect(f.value()).toBe(19200.000001);
  expect(f.current().past).toHaveLength(0);
  expect(f.adjusted.mock.calls[0][0]).toMatchObject({ notified: false, changed: false });
  const state = spy.mock.results[0].value.state;
  f.replaceProfile({ ...local });
  await act(async () => f.render());
  await wheel(120);
  expect(spy.mock.calls[1][2].state).toBe(state);
  expect(f.value()).toBe(19189);
  const ownState = spy.mock.results[1].value.state;
  await wheel(120);
  expect(spy.mock.calls[2][2].state).toBe(ownState);
  expect(f.value()).toBe(19179);
});
it('uses the latest foreign revision to discard unfocused state before React has rendered a peer edit', async () => {
  const spy = vi.spyOn(delay, 'hfdChannelDelayWheelNext'),
    f = await fixture();
  await wheel(-120);
  await act(async () => {
    f.foreign();
    field().dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
    );
  });
  expect(spy.mock.calls[1][2].state).toBeUndefined();
  expect(f.value()).toBe(21);
  expect(f.current().documents.right.presets[0].channels[0].name).toBe('Accepted foreign edit');
});
it.each(['Escape', 'blur'])(
  'a foreign accepted edit retires pending Text; %s cannot emit or erase it and a new edit renews authority',
  async (action) => {
    const f = await fixture();
    await enter('16');
    await act(async () => f.foreign());
    const accepted = structuredClone(f.current().documents);
    if (action === 'Escape') await key('Escape');
    else await act(async () => field().blur());
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.current().documents).toEqual(accepted);
    await enter('6');
    await key('Enter');
    expect(f.value()).toBe(11);
    expect(f.current().past).toHaveLength(2);
    await act(async () => f.current().undo());
    expect(f.current().documents).toEqual(accepted);
  },
);
it.each(['profile', 'context'] as const)(
  '%s changes invalidate pending Text, state and the old focus lease',
  async (kind) => {
    const spy = vi.spyOn(delay, 'hfdChannelDelayWheelNext'),
      f = await fixture();
    await wheel(-120);
    await enter('16');
    if (kind === 'profile')
      f.replaceProfile({ ...local, kind: 'global', maximumText: '74666.6666666667' });
    else f.replaceContext();
    await act(async () => f.render());
    expect(field().value).toBe('11');
    await key('Escape');
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.value()).toBe(11);
    await wheel(-120);
    expect(spy.mock.calls[1][2].state).toBeUndefined();
    expect(f.value()).toBe(21);
  },
);
it('rejection clears the proposed state and restores canonical Text before a later admitted event', async () => {
  const spy = vi.spyOn(delay, 'hfdChannelDelayWheelNext'),
    f = await fixture();
  await wheel(-120);
  f.reject(true);
  await wheel(-120);
  expect(f.value()).toBe(11);
  expect(field().value).toBe('11');
  expect(f.current().past).toHaveLength(1);
  f.reject(false);
  await wheel(120);
  expect(spy.mock.calls[2][2].state).toBeUndefined();
  expect(f.value()).toBe(0);
});
it.each([10.6666666667, 1])(
  'keeps arrow recurrence a browser request%s but displays the accepted native Text even for a no-op',
  async (step) => {
    const f = await fixture(0, { step });
    await act(async () => field().focus());
    await key('ArrowUp');
    expect(f.raw).toHaveBeenCalledExactlyOnceWith(String(step));
    expect(field().value).toBe(step === 1 ? '0' : '11');
    expect(f.value()).toBe(step === 1 ? 0 : 11);
  },
);
it('commits raw Text on ordinary blur and Escape cancels a later unfinished draft without a callback', async () => {
  const f = await fixture();
  await enter('16');
  await act(async () => field().blur());
  expect(f.raw).toHaveBeenCalledExactlyOnceWith('16');
  expect(f.value()).toBe(21);
  await enter('6');
  await key('Escape');
  expect(f.value()).toBe(21);
  expect(field().value).toBe('21');
  expect(f.raw).toHaveBeenCalledTimes(1);
  expect(f.current().past).toHaveLength(1);
});
it('rejects malformed dirty Text without publishing a hidden canonical fallback', async () => {
  const f = await fixture(17.123456789);
  await enter('-');
  await act(async () => field().blur());
  expect(f.raw).not.toHaveBeenCalled();
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.value()).toBe(17.123456789);
  expect(field().value).toBe('17');
  expect(f.current().past).toHaveLength(0);
});
it('a rejected raw commit restores canonical display and does not contaminate a later accepted commit', async () => {
  const f = await fixture();
  f.raw.mockReturnValueOnce(false);
  await enter('16');
  await key('Enter');
  expect(f.value()).toBe(0);
  expect(field().value).toBe('0');
  expect(f.current().past).toHaveLength(0);
  await enter('6');
  await key('Enter');
  expect(f.value()).toBe(11);
  expect(field().value).toBe('11');
});
it('normalizes Text and wheel through onChange when override callbacks are absent', async () => {
  const f = await fixture(0, { callbacks: false });
  await enter('16');
  await key('Enter');
  expect(f.changed).toHaveBeenCalledExactlyOnceWith(21);
  expect(f.raw).not.toHaveBeenCalled();
  await wheel(120);
  expect(f.value()).toBe(11);
  expect(f.adjusted).not.toHaveBeenCalled();
});
it('uses the Global profile final Text without reapplying its fractional maximum', async () => {
  const f = await fixture();
  f.replaceProfile({ ...local, kind: 'global', maximumText: '74666.6666666667' });
  await act(async () => f.render());
  await enter('100000');
  await key('Enter');
  expect(f.raw).toHaveBeenCalledExactlyOnceWith('100000');
  expect(f.value()).toBe(74667);
  expect(field().value).toBe('74667');
});
it('equivalent newly allocated profiles preserve unfinished Text and its focus lease', async () => {
  const f = await fixture();
  await enter('16');
  f.replaceProfile({ ...local });
  await act(async () => f.render());
  expect(field().value).toBe('16');
  expect(f.raw).not.toHaveBeenCalled();
  await key('Enter');
  expect(f.value()).toBe(21);
});
it('retains an own notified canonical no-op state across coupled revision acknowledgement and cancels only that field transaction', async () => {
  const spy = vi.spyOn(delay, 'hfdChannelDelayWheelNext'),
    f = await fixture(0, { coupledWheel: true });
  const before = structuredClone(f.current().documents);
  await enter('-10');
  await wheel(-120);
  expect(f.value()).toBe(0);
  expect(f.current().documents.right.presets[0].channels[0].name).toBe('Coupled Text notification');
  const state = spy.mock.results[0].value.state;
  await wheel(-120);
  expect(spy.mock.calls[1][2].state).toBe(state);
  expect(f.value()).toBe(11);
  await key('Escape');
  expect(f.current().documents).toEqual(before);
  expect(f.current().past).toHaveLength(0);
});
