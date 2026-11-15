// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DeviceSettings from '../src/components/DeviceSettings';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { decodeStatus, hex, type Controls } from '../src/hardware/codec';

let host: HTMLDivElement, root: Root;
const controls = vi.fn<(patch: Controls) => Promise<void>>(),
  refresh = vi.fn<() => Promise<void>>(),
  operated = vi.fn();
async function operate<T>(label: string, fn: () => Promise<T>): Promise<T> {
  operated(label);
  return fn();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  controls.mockReset().mockResolvedValue();
  refresh.mockReset().mockResolvedValue();
  operated.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
function amplifier(serial = 'SIM-UI', oled = true) {
  const panel = new SimulatedPanel(serial),
    backup = vi.fn(async () => {}),
    session = new PanelSession(panel, backup);
  panel.configuration[4] = oled ? 0x10 : 0;
  panel.deviceConfiguration[11] = serial === 'LEFT' ? 11 : 22;
  panel.deviceConfiguration[13] = 1;
  panel.deviceConfiguration[14] = 0x81;
  panel.deviceConfiguration[15] = 70;
  new DataView(panel.deviceConfiguration.buffer).setUint16(18, serial === 'LEFT' ? 111 : 222, true);
  panel.deviceConfiguration.set([40, 40, 80], 56);
  panel.deviceConfiguration.set([50, 50, 15], 59);
  panel.status[35] = 0xf6;
  const identity: Identity = {
    serial,
    product: 22,
    core: '5.1',
    firmware: '5.7',
    name: `${serial} design`,
    configuration: hex(panel.configuration),
  };
  return { panel, backup, session, identity };
}
async function render(f: ReturnType<typeof amplifier>) {
  await act(async () =>
    root.render(
      <DeviceSettings
        live={{ session: f.session, identity: f.identity, status: decodeStatus(f.panel.status) }}
        controls={controls}
        operate={operate}
        refresh={refresh}
      />,
    ),
  );
}
function numeric(label: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  return input!;
}
function select(label: string) {
  const control = [...host.querySelectorAll('select')].find(
    (element) =>
      element.getAttribute('aria-label') === label ||
      element.closest('label')?.firstChild?.textContent?.trim() === label,
  );
  expect(control, label).toBeDefined();
  return control!;
}
async function choose(element: HTMLSelectElement, value: number) {
  await act(async () => {
    element.value = String(value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function enter(element: HTMLInputElement, value: number) {
  await act(async () => element.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      element,
      String(value),
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => element.blur());
}
function field(label: string) {
  const dt = [...host.querySelectorAll('dt')].find((element) => element.textContent === label);
  return dt?.nextElementSibling?.textContent;
}
function toggle(label: string) {
  const element = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => input.closest('label')?.textContent === label,
  );
  expect(element, label).toBeDefined();
  return element!;
}

it('matches the screenshot native module and amplifier names and all four literal analogue input readouts', async () => {
  const f = amplifier();
  f.panel.deviceConfiguration[11] = 9;
  for (const [bits, xlr, rca] of [
    [0, '6.2 Vrms', '2.2 Vrms'],
    [64, '2.2 Vrms', '2.2 Vrms'],
    [128, '6.2 Vrms', '1.0 Vrms'],
    [192, '2.2 Vrms', '1.0 Vrms'],
  ] as const) {
    new DataView(f.panel.status.buffer).setUint16(9, 9 | bits, true);
    await render(f);
    expect(field('Maximum analogue XLR input')).toBe(xlr);
    expect(field('Maximum analogue RCA input')).toBe(rca);
  }
  expect(field('Configured module')).toBe('FA503 · code 9');
  expect(field('Configured amplifier')).toBe('NC502MP · code 5');
  expect(host.textContent).not.toContain('FA503 · code 5');
  expect(controls).not.toHaveBeenCalled();
  expect(f.panel.writes).toBe(0);
});

it.each([9, 1])(
  'shows the actual EEPROM module name for module %s independently of its enum and DSP filename',
  async (module) => {
    const f = amplifier();
    f.panel.deviceConfiguration[11] = module;
    f.panel.name = 'Different DSP filename';
    f.panel.eeprom.set(new TextEncoder().encode('Hypex EEPROM module'), 0x120);
    f.panel.eeprom.set(new TextEncoder().encode('OEM EEPROM module'), 0x140);
    await render(f);
    expect(field('Module name')).toBe(module === 1 ? 'OEM EEPROM module' : 'Hypex EEPROM module');
    expect(field('DSP filename')).toBe(f.identity.name);
    expect(field('Module name')).not.toBe(field('DSP filename'));
    expect(f.panel.writes).toBe(0);
    expect(controls).not.toHaveBeenCalled();
  },
);

it('uses native Volume on start checkbox semantics with a disabled visible level and -96 re-enable', async () => {
  const f = amplifier(),
    v = new DataView(f.panel.status.buffer);
  v.setInt16(21, -5000, true);
  await render(f);
  expect(toggle('Volume on start').checked).toBe(true);
  expect(numeric('Startup level').value).toBe('-50');
  await act(async () => toggle('Volume on start').click());
  expect(controls).toHaveBeenLastCalledWith({ startupVolume: null });
  v.setInt16(21, -20000, true);
  await render(f);
  expect(toggle('Volume on start').checked).toBe(false);
  expect(numeric('Startup level').value).toBe('-96');
  expect(numeric('Startup level').disabled).toBe(true);
  await act(async () => toggle('Volume on start').click());
  expect(controls).toHaveBeenLastCalledWith({ startupVolume: -96 });
  v.setInt16(21, -9600, true);
  await render(f);
  expect(numeric('Startup level').disabled).toBe(false);
  expect(controls).toHaveBeenCalledTimes(2);
  expect(f.panel.writes).toBe(0);
});

it('keeps native master and detection dependent controls visible but disabled without rewriting old stored values', async () => {
  const f = amplifier(),
    v = new DataView(f.panel.status.buffer);
  v.setUint16(9, 13, true);
  v.setInt16(21, -5000, true);
  const before = f.panel.status.slice();
  await render(f);
  for (const label of ['Wake on mains power', 'Activate signal detection', 'Volume on start'])
    expect(toggle(label).disabled).toBe(true);
  for (const label of ['Auto-off time', 'Startup level'])
    expect(numeric(label).disabled).toBe(true);
  for (const label of ['Shutdown power mode', 'Signal detection ON', 'Signal detection OFF'])
    expect(select(label).disabled).toBe(true);
  expect(host.textContent).toContain('IR remote disabled · slave mode');
  expect(f.panel.status).toEqual(before);
  expect(controls).not.toHaveBeenCalled();
  v.setUint16(9, 8, true);
  await render(f);
  expect(toggle('Wake on mains power').disabled).toBe(false);
  expect(toggle('Activate signal detection').disabled).toBe(false);
  expect(select('Shutdown power mode').disabled).toBe(false);
  expect(select('Signal detection ON').disabled).toBe(true);
  expect(select('Signal detection OFF').disabled).toBe(true);
  expect(numeric('Auto-off time').disabled).toBe(true);
  expect(host.textContent).toContain('IR remote enabled · master indicator');
  expect(host.textContent).toContain('Receiver presence is not confirmed');
});

it('drops an uncommitted numeric draft when its captured amplifier session is replaced', async () => {
  const left = amplifier('LEFT'),
    right = amplifier('RIGHT');
  await render(left);
  const old = numeric('Preset 1 offset');
  await act(async () => old.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(old, '9');
    old.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await render(right);
  expect(old.isConnected).toBe(false);
  expect(numeric('Preset 1 offset').value).toBe('0');
  await act(async () => old.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(controls).not.toHaveBeenCalled();
  expect(right.panel.writes).toBe(0);
});

it.each([0, 181, 255])(
  'shows retained auto-off time %s while new edits use native 1–180 minute bounds',
  async (value) => {
    const f = amplifier();
    f.panel.status[9] |= 1;
    f.panel.status[8] = value;
    await render(f);
    const input = numeric('Auto-off time');
    expect(input.value).toBe(String(value));
    expect(input.getAttribute('aria-valuemin')).toBe('1');
    expect(input.getAttribute('aria-valuemax')).toBe('180');
    expect(host.textContent).toContain(`Stored auto-off time ${value} min`);
    await act(async () => input.focus());
    await act(async () => input.blur());
    expect(controls).not.toHaveBeenCalled();
    expect(f.panel.status[8]).toBe(value);
    await enter(input, 256);
    expect(controls).toHaveBeenLastCalledWith({ powerOffMinutes: 180 });
  },
);

it('mounts with read-only hardware/identity/power queries and never sends mute/configuration/flash writes', async () => {
  const f = amplifier(),
    before = f.panel.status.slice(),
    deviceBefore = f.panel.deviceConfiguration.slice();
  await render(f);
  expect(field('Configured module')).toBe('Unknown module · code 22');
  expect(field('OLED version · numeric')).toBe('222');
  expect(f.panel.requests.length).toBeGreaterThan(0);
  expect(f.panel.requests.some((r) => r[0] === 6 && r[1] === 1)).toBe(true);
  expect(f.panel.requests.some((r) => r[0] === 0x66 && r[1] === 0)).toBe(true);
  expect(f.panel.requests.some((r) => r[0] === 8 && r[1] === 128)).toBe(true);
  // hardwareOverview establishes identity using name/serial reads too.
  for (const request of f.panel.requests)
    expect(
      (request[0] === 6 && request[1] === 1) ||
        (request[0] === 0x66 && request[1] === 0) ||
        (request[0] === 8 && request[1] === 128) ||
        (request[0] === 3 && request[1] === 8) ||
        request[0] === 0x65,
    ).toBe(true);
  expect(f.panel.status).toEqual(before);
  expect(f.panel.deviceConfiguration).toEqual(deviceBefore);
  expect(f.panel.displayUpdates).toBe(0);
  expect(f.panel.writes).toBe(0);
  expect(f.backup).not.toHaveBeenCalled();
  expect(controls).not.toHaveBeenCalled();
  expect(operated).not.toHaveBeenCalled();
});

it('labels current S/PDIF4 and AES5 correctly and submits exact native choices including Future7', async () => {
  const f = amplifier();
  f.panel.status[1] = 4;
  await render(f);
  expect(field('Active input')).toBe('S/PDIF');
  const source = select('Forced input');
  expect([...source.options].map((option) => [option.value, option.textContent])).toEqual([
    ['0', 'Auto'],
    ['1', 'XLR'],
    ['2', 'RCA'],
    ['3', 'Sub'],
    ['4', 'S/PDIF'],
    ['5', 'AES'],
    ['6', 'Optical'],
    ['7', 'Future'],
  ]);
  for (const id of [4, 5, 7]) {
    await choose(source, id);
    expect(controls).toHaveBeenLastCalledWith({ forceInput: id });
  }
  expect(controls).toHaveBeenCalledTimes(3);
  f.panel.status[1] = 5;
  await render(f);
  expect(field('Active input')).toBe('AES');
  expect(f.panel.writes).toBe(0);
});

it('shows unknown stored input enums without clamping or emitting a source write on mount', async () => {
  const f = amplifier();
  f.panel.status[1] = 15;
  f.panel.status[12] = 0xaf;
  await render(f);
  expect(field('Active input')).toBe('Unknown input (15)');
  const source = select('Forced input');
  expect(source.value).toBe('15');
  expect(source.selectedOptions[0].textContent).toBe('Unknown input (15)');
  expect(source.selectedOptions[0].disabled).toBe(true);
  expect(f.panel.status[12]).toBe(0xaf);
  expect(controls).not.toHaveBeenCalled();
});

it('identifies Future as a native selection while leaving firmware behavior unqualified', async () => {
  const f = amplifier();
  f.panel.status[1] = 7;
  f.panel.status[12] = 7;
  await render(f);
  expect(field('Active input')).toBe('Future');
  expect(host.textContent).toContain('its firmware behavior has not been qualified');
  expect(controls).not.toHaveBeenCalled();
});

it.each([7, 82])(
  'shows fresh actual state but disables unqualified firmware5.%s OFF with the central reason and no action',
  async (minor) => {
    const f = amplifier();
    new DataView(f.panel.configuration.buffer).setUint16(17, minor, true);
    f.identity.firmware = `5.${minor}`;
    const request = vi.spyOn(f.session, 'setPower');
    await render(f);
    expect(field('DSP power state')).toBe('on');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'DSP off',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain(minor === 7 ? 'caused USB loss' : 'has not been qualified');
    expect(host.textContent).toContain(button.title);
    const count = f.panel.requests.length;
    await act(async () => button.click());
    expect(request).not.toHaveBeenCalled();
    expect(f.panel.requests).toHaveLength(count);
    expect(controls).not.toHaveBeenCalled();
    expect(operated).not.toHaveBeenCalled();
    expect(f.panel.requests.some((r) => r[0] === 8 && r[1] === 128)).toBe(true);
  },
);

it('exposes advertised OLED brightness0..15 and submits zero/endpoints without truthiness or clamping errors', async () => {
  await render(amplifier());
  const maximum = numeric('OLED maximum brightness'),
    dimmed = numeric('OLED dimmed brightness');
  for (const input of [maximum, dimmed]) {
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-valuemin')).toBe('0');
    expect(input.getAttribute('aria-valuemax')).toBe('15');
  }
  await enter(maximum, 0);
  expect(controls).toHaveBeenLastCalledWith({ oledMaximumBrightness: 0 });
  await enter(dimmed, 15);
  expect(controls).toHaveBeenLastCalledWith({ oledDimmedBrightness: 15 });
  expect(controls).toHaveBeenCalledTimes(2);
});

it('keeps standby LED choices available without OLED capability and uses native non-linear wire labels', async () => {
  await render(amplifier('NO-OLED', false));
  expect(numeric('OLED maximum brightness').disabled).toBe(true);
  expect(numeric('OLED dimmed brightness').disabled).toBe(true);
  const standby = select('Standby LED brightness');
  expect(standby.disabled).toBe(false);
  expect([...standby.options].map((option) => [option.value, option.textContent])).toEqual([
    ['0', 'Off'],
    ['1', '100%'],
    ['2', '50%'],
    ['3', '25%'],
  ]);
  await choose(standby, 3);
  expect(controls).toHaveBeenCalledExactlyOnceWith({ standbyLedMode: 3 });
});

it('disables both OLED fields and standby LED selection when password locked', async () => {
  const f = amplifier();
  f.panel.status[51] = 2;
  await render(f);
  expect(numeric('OLED maximum brightness').disabled).toBe(true);
  expect(numeric('OLED dimmed brightness').disabled).toBe(true);
  expect(select('Standby LED brightness').disabled).toBe(true);
  expect(controls).not.toHaveBeenCalled();
});

it('shows the native dimmed-above6 warning while preserving the full stored brightness', async () => {
  const f = amplifier();
  f.panel.status[35] = 0xfc;
  await render(f);
  expect(numeric('OLED dimmed brightness').value).toBe('12');
  expect(host.textContent).toContain('brightness above 6');
  expect(controls).not.toHaveBeenCalled();
  f.panel.status[35] = 0xf6;
  await render(f);
  expect(host.textContent).not.toContain('brightness above 6');
  expect(controls).not.toHaveBeenCalled();
});

it.each([5, 6, 7])(
  'shows reserved stored DAC value%s without rewriting it and offers only the five native designs',
  async (stored) => {
    const f = amplifier();
    f.panel.status[10] = stored;
    await render(f);
    const dac = select('DAC filter mode');
    expect(dac.value).toBe(String(stored));
    expect(dac.selectedOptions[0].disabled).toBe(true);
    expect(dac.selectedOptions[0].textContent).toContain(`Stored value ${stored}`);
    expect(
      [...dac.options]
        .filter((option) => !option.disabled)
        .map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['0', 'Short delay, sharp roll-off'],
      ['1', 'Short delay, slow roll-off'],
      ['2', 'Sharp roll-off'],
      ['3', 'Slow roll-off'],
      ['4', 'Superslow roll-off'],
    ]);
    expect(controls).not.toHaveBeenCalled();
    await choose(dac, 3);
    expect(controls).toHaveBeenCalledExactlyOnceWith({ dacFilter: 3 });
  },
);

it('retains stored sound-quality4 visibly while offering1..3 and performs no automatic rewrite', async () => {
  const f = amplifier();
  f.panel.status[10] = 3 << 3;
  await render(f);
  const quality = select('Sound quality');
  expect(quality.value).toBe('4');
  expect(quality.selectedOptions[0].disabled).toBe(true);
  expect(quality.selectedOptions[0].textContent).toContain('Stored value 4');
  expect(
    [...quality.options].filter((option) => !option.disabled).map((option) => option.value),
  ).toEqual(['1', '2', '3']);
  expect(controls).not.toHaveBeenCalled();
  await choose(quality, 2);
  expect(controls).toHaveBeenCalledExactlyOnceWith({ soundQuality: 2 });
});

it('displays sensitivity1..4 but submits the recovered0..3 wire selections', async () => {
  await render(amplifier());
  for (const label of ['Signal detection ON', 'Signal detection OFF']) {
    const selector = select(label);
    expect([...selector.options].map((option) => [option.value, option.textContent])).toEqual([
      ['0', 'Sensitivity 1'],
      ['1', 'Sensitivity 2'],
      ['2', 'Sensitivity 3'],
      ['3', 'Sensitivity 4'],
    ]);
  }
  await choose(select('Signal detection ON'), 3);
  expect(controls).toHaveBeenLastCalledWith({ detectionOn: 3 });
  await choose(select('Signal detection OFF'), 0);
  expect(controls).toHaveBeenLastCalledWith({ detectionOff: 0 });
});

it.each(['resolve', 'reject'] as const)(
  'ignores a stale Left read%s after switching to a loaded Right session',
  async (completion) => {
    const left = amplifier('LEFT'),
      right = amplifier('RIGHT'),
      oldOverview = await left.session.hardwareOverview(),
      slow = deferred<typeof oldOverview>();
    vi.spyOn(left.session, 'hardwareOverview').mockReturnValue(slow.promise);
    await render(left);
    expect(host.textContent).toContain('Reading hardware configuration');
    await render(right);
    expect(field('Serial')).toBe('RIGHT');
    expect(field('Configured module')).toBe('Unknown module · code 22');
    expect(field('OLED version · numeric')).toBe('222');
    expect(controls).not.toHaveBeenCalled();
    if (completion === 'reject') {
      vi.spyOn(right.session, 'hardwareOverview').mockRejectedValueOnce(
        new Error('Right refresh failure'),
      );
      const button = [...host.querySelectorAll('button')].find(
        (item) => item.textContent === 'Refresh',
      )!;
      await act(async () => button.click());
      expect(host.textContent).toContain('Right refresh failure');
    }
    await act(async () => {
      if (completion === 'resolve') slow.resolve(oldOverview);
      else slow.reject(new Error('Left stale failure'));
    });
    expect(field('Serial')).toBe('RIGHT');
    expect(field('Configured module')).toBe('Unknown module · code 22');
    expect(field('OLED version · numeric')).toBe('222');
    expect(host.textContent).not.toContain('Left stale failure');
    if (completion === 'reject') expect(host.textContent).toContain('Right refresh failure');
    else expect(host.querySelector('.inline-error')).toBeNull();
    expect(left.backup).not.toHaveBeenCalled();
    expect(right.backup).not.toHaveBeenCalled();
    expect(left.panel.writes + right.panel.writes).toBe(0);
  },
);

it('keeps the newest same-session hardware overview when an older load completes later', async () => {
  const f = amplifier(),
    oldOverview = await f.session.hardwareOverview(),
    slow = deferred<typeof oldOverview>(),
    newer = { ...oldOverview, moduleType: 34 };
  vi.spyOn(f.session, 'hardwareOverview')
    .mockReturnValueOnce(slow.promise)
    .mockResolvedValueOnce(newer);
  await render(f);
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === 'Refresh',
  )!;
  await act(async () => button.click());
  expect(field('Configured module')).toBe('Unknown module · code 34');
  await act(async () => slow.resolve(oldOverview));
  expect(field('Configured module')).toBe('Unknown module · code 34');
  expect(host.querySelector('.inline-error')).toBeNull();
  expect(controls).not.toHaveBeenCalled();
  expect(f.backup).not.toHaveBeenCalled();
  expect(f.panel.writes).toBe(0);
});
