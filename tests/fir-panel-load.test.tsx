// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/hardware/storage', () => ({ listFirBackups: vi.fn(async () => []) }));
import FirPanel from '../src/components/FirPanel';
import { newProject, type Preset } from '../src/domain/model';
import { linkChannel } from '../src/domain/links';

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
const taps = (count: number, amplitude = 0.5) =>
  Array.from({ length: count }, (_, i) => (i === 1 ? amplitude : 0));
const loads = () =>
  [...host.querySelectorAll('button')].filter(
    (button) => button.textContent?.trim() === 'Load taps',
  );
const toggles = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
async function render(initial = newProject().presets[0]) {
  let current = initial;
  let receive: ((text: string, name: string) => void) | undefined;
  const run = vi.fn(async (_label: string, operation: () => Promise<void>) => operation());
  function Controlled() {
    const [preset, setPreset] = useState(initial);
    return (
      <FirPanel
        preset={preset}
        presetIndex={0}
        edit={(change) => {
          const next = structuredClone(preset);
          change(next);
          current = next;
          setPreset(next);
        }}
        run={run}
        readFile={(_accept, callback) => {
          receive = callback;
        }}
        notice={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  return {
    current: () => current,
    run,
    load: async (channel: number, amplitude = 0.5) => {
      await act(async () => loads()[channel].click());
      expect(receive).toBeDefined();
      await act(async () =>
        receive!(taps(channel === 0 ? 4500 : 1500, amplitude).join('\n'), `load-${amplitude}.txt`),
      );
      receive = undefined;
    },
  };
}

it('fresh Load taps remains bypassed, while replacing a manually enabled filter preserves enabled state', async () => {
  const f = await render();
  await f.load(0);
  expect(f.current().inputFir.enabled).toBe(false);
  expect(toggles()[0].checked).toBe(false);
  expect(toggles()[0].disabled).toBe(false);
  await act(async () => toggles()[0].click());
  expect(f.current().inputFir.enabled).toBe(true);
  await f.load(0, 0.25);
  expect(f.current().inputFir).toMatchObject({ name: 'load-0.25.txt', enabled: true });
  expect(f.current().inputFir.taps[1]).toBe(0.25);
  expect(toggles()[0].checked).toBe(true);
  expect(f.run).not.toHaveBeenCalled();
});

it('loading taps into an inactive output does not select it or bypass the independently enabled input', async () => {
  const p = newProject().presets[0];
  p.inputFir = { name: 'Independent input', enabled: true, taps: taps(4500) };
  const f = await render(p);
  await f.load(1);
  expect(f.current().firPlacement).toBe('input');
  expect(f.current().inputFir).toEqual(p.inputFir);
  expect(f.current().channels[0].fir.enabled).toBe(false);
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="FIR placement"]')!.value).toBe(
    'input',
  );
  expect(toggles()[0].checked).toBe(true);
  expect(toggles()[1].disabled).toBe(true);
  expect(f.run).not.toHaveBeenCalled();
});

it('keeps a linked output read-only and explicit browser Unload clears and bypasses without uploading', async () => {
  const p = newProject().presets[0];
  p.inputFir = { name: 'Input', enabled: true, taps: taps(4500) };
  linkChannel(p, 1, 0);
  const f = await render(p);
  expect(loads()[2].disabled).toBe(true);
  expect(toggles()[2].disabled).toBe(true);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[title="Unload FIR"]')!.click(),
  );
  expect(f.current().inputFir).toEqual({ name: '', taps: [], enabled: false });
  expect(f.current().firPlacement).toBe('input');
  expect(f.run).not.toHaveBeenCalled();
});
