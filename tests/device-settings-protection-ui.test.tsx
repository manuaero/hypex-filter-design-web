// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceSettings from '../src/components/DeviceSettings';
import AmplifierConfiguration from '../src/components/AmplifierConfiguration';
import { createAmplifierModesController } from '../src/application/amplifier-modes';
import { decodeStatus, hex, type Controls } from '../src/hardware/codec';
import { decodeLimiter, encodeLimiter } from '../src/hardware/device-settings';
import { OEM_ITEMS } from '../src/hardware/protection';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

let host: HTMLDivElement, root: Root;
const controls = vi.fn<(patch: Controls) => Promise<void>>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  controls.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const bit = (id: string) => OEM_ITEMS.find((item) => item.id === id)!.mask;
function fixture(mask = 0, moduleType = 0, flags = 2) {
  const panel = new SimulatedPanel('OEM-UI-SIMULATION'),
    session = new PanelSession(panel, async () => {});
  panel.configuration[4] = 0x12; // OLED plus native digital mixer group.
  panel.deviceConfiguration[11] = moduleType;
  panel.status[51] = flags;
  panel.status[24] = mask & 255;
  panel.status[25] = mask >> 8;
  panel.status[9] = 4; // Slave mode, so lock controls aren't disabled merely by being master.
  panel.status[35] = 0xc5;
  panel.deviceConfiguration = encodeLimiter(
    decodeLimiter(panel.deviceConfiguration),
    Array.from({ length: 3 }, () => ({ watts: 25, ohms: 4, attackMs: 10, releaseMs: 250 })),
    false,
  );
  panel.deviceConfiguration[1] = 0;
  const identity: Identity = {
    serial: panel.serial,
    product: 22,
    core: '5.1',
    firmware: '5.7',
    name: 'Synthetic',
    configuration: hex(panel.configuration),
  };
  return { panel, session, identity };
}
async function render(f: ReturnType<typeof fixture>) {
  await f.session.identify();
  const live = { session: f.session, identity: f.identity, status: decodeStatus(f.panel.status) };
  const modeController = createAmplifierModesController({
    binding: (slot) => (slot === 'left' ? live : undefined),
    operate: async (_label, work) => work(),
  });
  modeController.refreshBindings();
  controls.mockImplementation(async (patch) => {
    await f.session.preflightControls(patch);
    await f.session.setControls(patch);
  });
  await act(async () =>
    root.render(
      <>
        <AmplifierConfiguration
          controller={modeController}
          slot="left"
          connectedRoles={['left']}
          getContext={() => ({
            owner: 'workspace:11111111-1111-4111-8111-111111111111',
            scope: 'ui:protection',
          })}
        />
        <DeviceSettings
          live={{ session: f.session, identity: f.identity, status: decodeStatus(f.panel.status) }}
          controls={controls}
          operate={async (_label, fn) => fn()}
          refresh={async () => {}}
        />
      </>,
    ),
  );
}
function select(label: string) {
  const found = [...host.querySelectorAll('select')].find(
    (element) =>
      element.getAttribute('aria-label') === label ||
      element.closest('label')?.textContent?.trim().startsWith(label),
  );
  expect(found, label).toBeDefined();
  return found!;
}
function toggle(label: string) {
  const found =
    host.querySelector<HTMLInputElement>(`input[aria-label="Left ${label}"]`) ??
    [...host.querySelectorAll('label')]
      .find((element) => element.textContent?.trim() === label)
      ?.querySelector<HTMLInputElement>('input');
  expect(found, label).toBeDefined();
  return found!;
}
function numeric(label: string) {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const disabled = (element: Element) => element.matches(':disabled');
const writes = (panel: SimulatedPanel) =>
  panel.requests.filter(
    (r) =>
      r[0] === 0x64 ||
      ([3, 5].includes(r[0]) && r[1] === 0) ||
      (r[0] === 0x66 && r[1] === 1) ||
      (r[0] === 8 && r[1] !== 128),
  );

describe('actual DeviceSettings native OEM access rendering', () => {
  it('keeps source control usable on a locked standard panel with stored mask0 and performs only the requested runtime change', async () => {
    const f = fixture();
    await render(f);
    const source = select('Force input');
    expect(disabled(source)).toBe(false);
    expect(disabled(numeric('Auto-off time'))).toBe(true);
    expect(writes(f.panel)).toHaveLength(0);
    await act(async () => {
      source.value = '3';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(controls).toHaveBeenCalledExactlyOnceWith({ forceInput: 3 });
    expect(f.panel.status[12] & 15).toBe(3);
    expect(decodeStatus(f.panel.status).locked).toBe(true);
    expect(f.panel.status.slice(24, 26)).toEqual(new Uint8Array([0, 0]));
    expect(writes(f.panel)).toHaveLength(1);
    expect(f.panel.requests.some((r) => r[0] === 4)).toBe(false);
  });

  it('denies generic settings and power on a protected standard module despite all stored OEM bits', async () => {
    const f = fixture(0xffff, 2);
    await render(f);
    for (const element of [
      numeric('OLED maximum brightness'),
      select('Standby LED brightness'),
      numeric('Auto-off time'),
      toggle('Wake on mains power'),
      select('DAC filter mode'),
      button('DSP off'),
    ])
      expect(disabled(element)).toBe(true);
    await act(async () => button('DSP off').click());
    expect(writes(f.panel)).toHaveLength(0);
    expect(host.textContent).toContain('standard or unknown module');
  });

  it('enables OEM generic settings from entrybit3 without granting special settings or unknown controls', async () => {
    const f = fixture(bit('deviceSettings'), 1);
    await render(f);
    for (const element of [numeric('OLED maximum brightness'), select('Standby LED brightness')])
      expect(disabled(element)).toBe(false);
    // The fixture is a slave: native mode constraints remain even with OEM settings access.
    expect(disabled(numeric('Auto-off time'))).toBe(true);
    expect(disabled(toggle('Wake on mains power'))).toBe(true);
    expect(disabled(button('DSP off'))).toBe(true);
    expect(button('DSP off').title).toContain('recovery is not qualified');
    for (const element of [
      select('DAC filter mode'),
      toggle('Soft clip enabled'),
      toggle('Master unit'),
      toggle('Bridged CH1 + CH2'),
      select('Digital channel'),
    ])
      expect(disabled(element)).toBe(true);
    expect(writes(f.panel)).toHaveLength(0);
  });

  it.each(['softclipLimiter', 'bridge', 'masterSlave', 'dacFilter', 'digitalLeftRight'] as const)(
    'intersects entry and %s child permission in actual controls',
    async (operation) => {
      const f = fixture(bit(operation), 1);
      const controlFor = () =>
        operation === 'softclipLimiter'
          ? toggle('Soft clip enabled')
          : operation === 'bridge'
            ? toggle('Bridged CH1 + CH2')
            : operation === 'masterSlave'
              ? toggle('Master unit')
              : operation === 'dacFilter'
                ? select('DAC filter mode')
                : select('Digital channel');
      await render(f);
      expect(disabled(controlFor())).toBe(true);
      f.panel.status[24] |= bit('deviceSettings');
      await render(f);
      expect(disabled(controlFor())).toBe(false);
      if (operation === 'dacFilter') {
        expect(disabled(select('Sound quality'))).toBe(false);
        expect(disabled(numeric('FIR filter mode'))).toBe(false);
      }
      expect(writes(f.panel)).toHaveLength(0);
    },
  );

  it('keeps unmapped source-lock, volume-lock and ADC fields refused while protected even with full OEM mask', async () => {
    const f = fixture(0xffff, 1);
    await render(f);
    expect(toggle('Master unit').checked).toBe(false);
    for (const label of ['Source lock', 'Volume lock', 'Analog input to digital output']) {
      expect(disabled(toggle(label))).toBe(true);
      await act(async () => toggle(label).click());
    }
    expect(controls).not.toHaveBeenCalled();
    expect(writes(f.panel)).toHaveLength(0);
  });

  it('keeps hardware preset and individual output mutes usable with every stored bit clear', async () => {
    const f = fixture();
    await render(f);
    expect(disabled(select('Hardware preset'))).toBe(false);
    for (const label of ['Output 1 mute', 'Output 2 mute', 'Output 3 mute'])
      expect(disabled(toggle(label))).toBe(false);
    await act(async () => toggle('Output 2 mute').click());
    expect(controls).toHaveBeenLastCalledWith({ outputMute: { channel: 2, muted: true } });
    const preset = select('Hardware preset');
    await act(async () => {
      preset.value = '2';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(controls).toHaveBeenLastCalledWith({ preset: 2 });
    expect(decodeStatus(f.panel.status)).toMatchObject({
      preset: 2,
      locked: true,
      channelMutes: [false, true, false],
    });
    expect(writes(f.panel)).toHaveLength(2);
    expect(f.panel.status.slice(24, 26)).toEqual(new Uint8Array([0, 0]));
  });

  it('uses password-matched state to restore access without changing the stored mask or issuing password commands', async () => {
    const f = fixture(0, 0, 6);
    await render(f);
    for (const element of [
      select('DAC filter mode'),
      toggle('Source lock'),
      toggle('Volume lock'),
      toggle('Analog input to digital output'),
    ])
      expect(disabled(element)).toBe(false);
    expect(disabled(numeric('Auto-off time'))).toBe(true); // Slave mode remains a separate constraint.
    expect(host.textContent).toContain('Password verified');
    expect(f.panel.status.slice(24, 26)).toEqual(new Uint8Array([0, 0]));
    expect(writes(f.panel)).toHaveLength(0);
    expect(f.panel.requests.some((r) => r[0] === 4)).toBe(false);
  });

  it('keeps generic protected settings unavailable until fresh module metadata has loaded', async () => {
    const f = fixture(bit('deviceSettings'), 1),
      read = f.session.hardwareOverview.bind(f.session),
      result = await read();
    let resolve!: (value: typeof result) => void;
    vi.spyOn(f.session, 'hardwareOverview').mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render(f);
    expect(disabled(numeric('OLED maximum brightness'))).toBe(true);
    expect(disabled(select('Force input'))).toBe(false);
    await act(async () => resolve(result));
    expect(disabled(numeric('OLED maximum brightness'))).toBe(false);
    expect(writes(f.panel)).toHaveLength(0);
  });

  it('shows fourteen stored/effective bits separately from runtime access, without writes', async () => {
    const f = fixture();
    await render(f);
    const table = host.querySelector('table')!;
    expect(table.querySelectorAll('tbody tr')).toHaveLength(14);
    const row = [...table.querySelectorAll('tbody tr')].find((element) =>
      element.textContent?.includes('Input source'),
    )!;
    expect(row.textContent).toContain('Available');
    expect(row.textContent).toMatch(/Off|No|0|Disabled/);
    expect(writes(f.panel)).toHaveLength(0);
  });
});
