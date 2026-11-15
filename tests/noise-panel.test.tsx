// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NoisePanel from '../src/components/NoisePanel';
import { createNoiseController, type NoiseConnection } from '../src/application/noise-control';
import type { PanelSession } from '../src/hardware/session';
import type { NoiseIdentity, NoiseResult, RotatingNoiseState } from '../src/hardware/noise';
import type { Slot } from '../src/domain/model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const identity = (serial: string): NoiseIdentity => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.82',
});
function fixture(both = true) {
  const left = {} as PanelSession,
    right = {} as PanelSession,
    states = new Map<PanelSession, RotatingNoiseState>();
  const connections: Partial<Record<Slot, NoiseConnection>> = {
    left: { session: left, identity: identity('LEFT') },
    ...(both ? { right: { session: right, identity: identity('RIGHT') } } : {}),
  };
  const preflight = vi.fn(async (s: PanelSession) => identity(s === left ? 'LEFT' : 'RIGHT'));
  const send = vi.fn(
    async (s: PanelSession, enabled: boolean, expected?: NoiseIdentity): Promise<NoiseResult> => {
      states.set(s, { requested: enabled, acknowledgement: 'accepted' });
      return {
        identity: expected!,
        requested: enabled,
        acknowledged: true,
        actualState: 'unavailable',
        status: {} as never,
      };
    },
  );
  const controller = createNoiseController({
    connections: () => connections,
    preflight,
    send,
    getState: (s) => states.get(s) ?? { requested: null, acknowledgement: 'none' },
    operate: (_label, work) => work(),
  });
  return { controller, left, right, connections, preflight, send };
}
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
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const both = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;

it('does not start on mount and permits Stop on a connected amp with unknown state', async () => {
  const f = fixture(false),
    onError = vi.fn(),
    onResult = vi.fn();
  await act(async () =>
    root.render(<NoisePanel controller={f.controller} onError={onError} onResult={onResult} />),
  );
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Command state unknown');
  expect(host.textContent).toContain('Offline');
  expect(button('Stop rotating noise on Left').disabled).toBe(false);
  expect(button('Stop rotating noise on Right').disabled).toBe(true);
  expect(both('Start both').disabled).toBe(true);
  expect(both('Stop both').disabled).toBe(true);
  await act(async () => button('Stop rotating noise on Left').click());
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.left, false, identity('LEFT'));
  expect(host.textContent).toContain('Stop acknowledged');
  expect(host.textContent).toContain('not the actual sound state');
  expect(host.textContent).toContain('Stop before disconnecting');
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});
it('keeps the other role usable while one command is waiting and disables paired/reentrant actions', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>(),
    onError = vi.fn();
  f.preflight.mockImplementation(async (s) => (s === f.left ? gate.promise : identity('RIGHT')));
  await act(async () => root.render(<NoisePanel controller={f.controller} onError={onError} />));
  await act(async () => button('Start rotating noise on Left').click());
  expect(button('Start rotating noise on Left').disabled).toBe(true);
  expect(button('Stop rotating noise on Left').disabled).toBe(true);
  expect(button('Stop rotating noise on Right').disabled).toBe(false);
  expect(both('Stop both').disabled).toBe(true);
  await act(async () => button('Stop rotating noise on Right').click());
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.right, false, identity('RIGHT'));
  await act(async () => gate.resolve(identity('LEFT')));
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(button('Stop rotating noise on Left').disabled).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});
it('surfaces paired preflight refusal without sending either request or hiding individual Stop', async () => {
  const f = fixture(),
    onError = vi.fn();
  f.preflight.mockImplementation(async (s) => {
    if (s === f.right) throw new Error('Read denied');
    return identity('LEFT');
  });
  await act(async () => root.render(<NoisePanel controller={f.controller} onError={onError} />));
  await act(async () => both('Start both').click());
  expect(f.send).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      complete: false,
      roles: expect.objectContaining({
        left: expect.objectContaining({ write: 'not-sent' }),
        right: expect.objectContaining({ preflight: 'failed', write: 'not-sent' }),
      }),
    }),
  );
  expect(button('Stop rotating noise on Left').disabled).toBe(false);
  expect(host.textContent).toContain('preflight did not confirm');
});
it('reflects commands issued through the same shared service without an extra UI command', async () => {
  const f = fixture(),
    onError = vi.fn();
  await act(async () => root.render(<NoisePanel controller={f.controller} onError={onError} />));
  await act(async () => {
    await f.controller.set('right', true);
  });
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.right, true, identity('RIGHT'));
  expect(host.textContent).toContain('Start acknowledged');
  expect(onError).not.toHaveBeenCalled();
});

it('pauses all noise buttons while another USB operation owns the connection without changing command state', async () => {
  const f = fixture(),
    onError = vi.fn();
  await act(async () =>
    root.render(<NoisePanel controller={f.controller} onError={onError} paused />),
  );
  expect(
    [...host.querySelectorAll<HTMLButtonElement>('button')].every((item) => item.disabled),
  ).toBe(true);
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().left.requested).toBeNull();
  await act(async () =>
    root.render(<NoisePanel controller={f.controller} onError={onError} paused={false} />),
  );
  expect(button('Stop rotating noise on Left').disabled).toBe(false);
  expect(both('Stop both').disabled).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
