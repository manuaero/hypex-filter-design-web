// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/hardware/storage', () => ({ listFirBackups: vi.fn(async () => []) }));
import FirPanel from '../src/components/FirPanel';
import { newProject, type Fir, type Preset } from '../src/domain/model';
import { applyNativeFirAction } from '../src/domain/fir-editing';
import * as firHardware from '../src/hardware/fir';

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
const data = (n: number, amplitude = 0.5) =>
  Array.from({ length: n }, (_, i) => (i === 1 ? amplitude : 0));
const fir = (n: number, enabled: boolean, used: boolean): Fir => ({
  name: 'Original.txt',
  enabled,
  taps: data(n),
  hfdState: { loaded: true, used, tapCount: n },
});
function fixture() {
  const p = newProject().presets[0];
  p.firPlacement = 'output';
  p.inputFir = fir(4500, true, false);
  p.channels.forEach((c) => {
    c.fir = fir(1500, true, true);
  });
  return p;
}
const checkbox = (index: number) =>
  host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index];
const buttons = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent?.trim() === text,
  );
async function render(initial: Preset, selectedOutputIndex = 0) {
  let current = initial,
    receive: ((text: string, name: string) => void) | undefined;
  const run = vi.fn(async (_label: string, action: () => Promise<void>) => action());
  function Controlled() {
    const [p, setPreset] = useState(initial);
    const edit = (action: (p: Preset) => void) => {
      const next = structuredClone(p);
      action(next);
      current = next;
      setPreset(next);
    };
    return (
      <FirPanel
        preset={p}
        presetIndex={0}
        selectedOutputIndex={selectedOutputIndex}
        onNativeAction={(action) => edit((next) => applyNativeFirAction(next, action))}
        edit={edit}
        run={run}
        readFile={(_accept, callback) => {
          receive = callback;
        }}
        notice={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Controlled />));
  return { current: () => current, run, receive: () => receive };
}

it('shows the inactive graph advisory before explicit Upload and passes the unchanged two-Used design to hardware', async () => {
  const preset = fixture();
  preset.inputFir.hfdState!.used = true;
  const before = structuredClone(preset),
    upload = vi.spyOn(firHardware, 'uploadFir').mockResolvedValue(undefined),
    session = {} as never,
    edit = vi.fn(),
    notice = vi.fn(),
    run = vi.fn(async (_label: string, work: () => Promise<void>) => work());
  await act(async () =>
    root.render(
      <FirPanel
        preset={preset}
        presetIndex={0}
        live={{ session, identity: {} as never }}
        edit={edit}
        run={run}
        readFile={vi.fn()}
        notice={notice}
      />,
    ),
  );
  const advisory = host.querySelector<HTMLElement>('[aria-label="FIR upload scope"]')!,
    button = buttons('Upload FIR')[0];
  expect(advisory.textContent).toBe(
    'Inactive input graph FIR is not transferred; only the selected placement is programmed.',
  );
  expect(advisory.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(button.disabled).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(upload).toHaveBeenCalledExactlyOnceWith(session, 1, preset);
  expect(edit).not.toHaveBeenCalled();
  expect(preset).toEqual(before);
  expect(notice).toHaveBeenCalledWith(
    'FIR flash, names and activation verified. Outputs remain muted.',
  );
});

it('removes the advisory after explicit placement selection marks the opposite graph banks unused, without uploading', async () => {
  const preset = fixture();
  preset.inputFir.hfdState!.used = true;
  const initial = structuredClone(preset),
    f = await render(preset);
  expect(host.querySelector('[aria-label="FIR upload scope"]')).not.toBeNull();
  const select = host.querySelector<HTMLSelectElement>('[aria-label="FIR placement"]')!;
  await act(async () => {
    select.value = 'input';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('[aria-label="FIR upload scope"]')).toBeNull();
  expect(f.current().inputFir.taps).toEqual(initial.inputFir.taps);
  expect(f.current().channels.map((channel) => channel.fir.taps)).toEqual(
    initial.channels.map((channel) => channel.fir.taps),
  );
  expect(f.run).not.toHaveBeenCalled();
});

it('native placement changes Used while retaining both placements’ independent enable settings and loaded data', async () => {
  const f = await render(fixture());
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="FIR placement"]')!;
  await act(async () => {
    select.value = 'input';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(f.current().firPlacement).toBe('input');
  expect(f.current().inputFir).toMatchObject({
    enabled: true,
    hfdState: { loaded: true, used: true },
  });
  expect(
    f
      .current()
      .channels.every((c) => c.fir.enabled && c.fir.hfdState!.loaded && !c.fir.hfdState!.used),
  ).toBe(true);
  expect(checkbox(0).checked).toBe(true);
  expect(checkbox(1).checked).toBe(true);
  expect(checkbox(1).disabled).toBe(true);
  expect(host.textContent).toContain('Loaded · inactive placement');
  expect(f.run).not.toHaveBeenCalled();
});

it('native Clear targets the selected linked output plus input without rewriting its source, latent enable or count', async () => {
  const p = fixture();
  p.channels[1].linkedTo = 0;
  const source = structuredClone(p.channels[0].fir),
    unrelated = structuredClone(p.channels[2].fir);
  const f = await render(p, 1);
  const clear = buttons(`Clear input + ${p.channels[1].name}`)[0];
  expect(clear.disabled).toBe(false);
  await act(async () => clear.click());
  expect(f.current().inputFir).toEqual({
    name: '',
    taps: [],
    enabled: true,
    hfdState: { loaded: false, used: false, tapCount: 4500 },
  });
  expect(f.current().channels[1].fir).toEqual({
    name: '',
    taps: [],
    enabled: true,
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  });
  expect(f.current().channels[0].fir).toEqual(source);
  expect(f.current().channels[2].fir).toEqual(unrelated);
  expect(checkbox(2).checked).toBe(true);
  expect(checkbox(2).disabled).toBe(false);
  expect(host.textContent).toContain('Awaiting FIR data · enable setting retained');
  expect(buttons('Load taps')[2].disabled).toBe(true);
  expect(f.run).not.toHaveBeenCalled();
});

it('lets native latent enable change after Clear and retains that choice when data is reloaded', async () => {
  const f = await render(fixture());
  await act(async () => buttons(`Clear input + ${f.current().channels[0].name}`)[0].click());
  const empty = structuredClone(f.current().channels[0].fir);
  expect(empty.hfdState?.loaded).toBe(false);
  expect(checkbox(1).checked).toBe(true);
  expect(checkbox(1).disabled).toBe(false);
  expect(checkbox(0).disabled).toBe(true); // Shared input remains outside selected placement.
  await act(async () => checkbox(1).click());
  expect(f.current().channels[0].fir).toEqual({ ...empty, enabled: false });
  expect(f.current().inputFir.enabled).toBe(true);
  await act(async () => buttons('Load taps')[1].click());
  await act(async () => f.receive()!(data(1500).join('\n'), 'Reloaded.txt'));
  expect(f.current().channels[0].fir).toMatchObject({
    enabled: false,
    name: 'Reloaded.txt',
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  });
  expect(checkbox(1).checked).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
});

it('keeps the legacy unmarked empty FIR enable guard', async () => {
  const f = await render(newProject().presets[0]);
  expect(checkbox(0).disabled).toBe(true);
  expect(f.current().inputFir).toEqual({ name: '', enabled: false, taps: [] });
});

it('keeps native Clear available for unloaded resources with stale names and retained state', async () => {
  const p = newProject().presets[0];
  p.inputFir = {
    name: 'Old input.txt',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 4500 },
  };
  p.channels[1].fir = {
    name: 'Old output.txt',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  };
  const f = await render(p, 1),
    clear = buttons(`Clear input + ${p.channels[1].name}`)[0];
  expect(clear.disabled).toBe(false);
  await act(async () => clear.click());
  expect(f.current().inputFir).toEqual({
    name: '',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: false, tapCount: 4500 },
  });
  expect(f.current().channels[1].fir).toEqual({
    name: '',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  });
});

it('clear then reload restores a retained enable setting, and marked bypass does not disable the opposite FIR', async () => {
  const p = fixture(),
    f = await render(p);
  await act(async () => buttons(`Clear input + ${p.channels[0].name}`)[0].click());
  await act(async () => buttons('Load taps')[1].click());
  await act(async () => f.receive()!(data(1500, 0.25).join('\n'), 'Replacement.txt'));
  expect(f.current().channels[0].fir).toMatchObject({
    enabled: true,
    name: 'Replacement.txt',
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  });
  expect(checkbox(1).checked).toBe(true);
  expect(checkbox(1).disabled).toBe(false);
  await act(async () => checkbox(1).click());
  expect(f.current().channels[0].fir.enabled).toBe(false);
  expect(f.current().inputFir.enabled).toBe(true);
  expect(f.current().firPlacement).toBe('output');
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>('button[title="Unload FIR"]')[1].click(),
  );
  expect(f.current().channels[0].fir).toEqual({ name: '', enabled: false, taps: [] });
  expect(f.run).not.toHaveBeenCalled();
});

it('captures the original load target while native callbacks follow the currently rendered selected output', async () => {
  const left = fixture(),
    right = fixture();
  let receive: ((text: string, name: string) => void) | undefined;
  const editLeft = vi.fn((fn: (p: Preset) => void) => fn(left));
  const editRight = vi.fn((fn: (p: Preset) => void) => fn(right));
  const nativeLeft = vi.fn(),
    nativeRight = vi.fn();
  const props = {
    presetIndex: 0,
    run: vi.fn(async () => {}),
    readFile: (_accept: string, cb: (text: string, name: string) => void) => {
      receive = cb;
    },
    notice: vi.fn(),
  };
  await act(async () =>
    root.render(
      <FirPanel
        {...props}
        preset={left}
        selectedOutputIndex={0}
        edit={editLeft}
        onNativeAction={nativeLeft}
      />,
    ),
  );
  await act(async () => buttons('Load taps')[0].click());
  await act(async () =>
    root.render(
      <FirPanel
        {...props}
        preset={right}
        selectedOutputIndex={2}
        edit={editRight}
        onNativeAction={nativeRight}
      />,
    ),
  );
  await act(async () => receive!(data(4500, 0.125).join('\n'), 'Late-left.txt'));
  expect(editLeft).toHaveBeenCalledOnce();
  expect(editRight).not.toHaveBeenCalled();
  expect(left.inputFir.name).toBe('Late-left.txt');
  expect(right.inputFir.name).toBe('Original.txt');
  await act(async () => buttons(`Clear input + ${right.channels[2].name}`)[0].click());
  expect(nativeRight).toHaveBeenCalledExactlyOnceWith({ kind: 'clear', output: 3 });
  expect(nativeLeft).not.toHaveBeenCalled();
});

it('delivers an asynchronous explicit read to its captured original host callback with raw flags intact', async () => {
  let finish!: (result: Awaited<ReturnType<typeof firHardware.readFir>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof firHardware.readFir>>>((resolve) => {
    finish = resolve;
  });
  const read = vi.spyOn(firHardware, 'readFir').mockReturnValue(pending),
    left = fixture(),
    right = fixture(),
    onLeft = vi.fn(),
    onRight = vi.fn(),
    edit = vi.fn(),
    session = {} as never,
    props = {
      presetIndex: 0,
      live: { session, identity: {} as never },
      edit,
      run: vi.fn(async (_label: string, fn: () => Promise<void>) => fn()),
      readFile: vi.fn(),
      notice: vi.fn(),
    };
  await act(async () => root.render(<FirPanel {...props} preset={left} onReadFir={onLeft} />));
  await act(async () => buttons('Read FIR')[0].click());
  expect(read).toHaveBeenCalledExactlyOnceWith(session, 1);
  await act(async () =>
    root.render(<FirPanel {...props} preset={right} presetIndex={2} onReadFir={onRight} />),
  );
  const result = {
    placement: 'output' as const,
    filters: left.channels.map((c) => c.fir),
    flags: 0x7f,
    backup: {} as never,
  };
  await act(async () => {
    finish(result);
    await pending;
  });
  expect(onLeft).toHaveBeenCalledExactlyOnceWith(result);
  expect(onRight).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
});
