import { describe, expect, it } from 'vitest';
import {
  control,
  decodeStatus,
  hasDisplayControls,
  hex,
  settings,
  type Controls,
} from '../src/hardware/codec';
import { decodeHardwareOverview } from '../src/hardware/device-settings';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

function fixture(oled = true) {
  const panel = new SimulatedPanel(),
    backups: Backup[] = [],
    session = new PanelSession(panel, async (backup) => {
      backups.push(backup);
    });
  panel.configuration[4] = oled ? 0x10 : 0;
  panel.status[35] = 0xb2;
  panel.status[36] = 0xe7;
  return { panel, session, backups };
}
const controlWrites = (panel: SimulatedPanel) =>
  panel.requests.filter((request) => request[0] === 5 && request[1] === 0);

it('uses literal native analogue maxima and the master indicator without inventing receiver presence', () => {
  const { panel } = fixture(),
    v = new DataView(panel.status.buffer);
  for (const [bits, xlr, rca] of [
    [0, 6.15, 2.18],
    [64, 2.18, 2.18],
    [128, 6.15, 0.98],
    [192, 2.18, 0.98],
  ]) {
    v.setUint16(9, bits, true);
    expect(settings(decodeStatus(panel.status))).toMatchObject({
      maximumAnalogXlrVrms: xlr,
      maximumAnalogRcaVrms: rca,
      irRemoteMasterIndicator: true,
    });
  }
  v.setUint16(9, 4, true);
  expect(settings(decodeStatus(panel.status)).irRemoteMasterIndicator).toBe(false);
});

it('reconstructs native Slave coupling while preserving unrelated runtime, security, FIR and display fields', () => {
  const { panel } = fixture(),
    raw = panel.status;
  raw[2] = 2;
  raw[6] = 0x85;
  raw[7] = 1;
  raw[8] = 77;
  const view = new DataView(raw.buffer);
  view.setInt16(3, -1725, true);
  view.setUint16(9, 0xe7db, true);
  view.setInt16(21, -5000, true);
  raw.set([0xa5, 0x5a], 24);
  raw[36] &= ~4;
  const source = decodeStatus(raw),
    before = source.raw.slice(),
    request = control(source, { master: false }),
    planned = settings(decodeStatus(request));
  expect(request[9]).toBe(0xd6);
  expect(request[10]).toBe(0xe7);
  expect(request.slice(21, 23)).toEqual(Uint8Array.of(0xe0, 0xb1));
  expect(planned).toMatchObject({
    master: false,
    wakeOnLine: false,
    signalDetection: false,
    startupVolume: -200,
    startupVolumeEnabled: false,
    standbyMode: 0,
  });
  const copied = [
    2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29, 30,
    31, 35, 36,
  ];
  for (const offset of copied.filter((i) => ![7, 9, 21, 22].includes(i)))
    expect(request[offset], `preserved byte ${offset}`).toBe(before[offset]);
  expect(source.raw).toEqual(before);
  expect(request[23]).toBe(0);
  const conflicting = control(source, {
    master: false,
    wakeOnLine: true,
    signalDetection: true,
    startupVolume: -20,
    standbyMode: 1,
  });
  expect(settings(decodeStatus(conflicting))).toMatchObject({
    master: false,
    wakeOnLine: false,
    signalDetection: false,
    startupVolume: -200,
    standbyMode: 0,
  });
  const unrelated = control(source, { volume: -25 });
  expect(settings(decodeStatus(unrelated))).toMatchObject({
    master: true,
    wakeOnLine: true,
    signalDetection: true,
    startupVolume: -50,
    standbyMode: 1,
  });
});

it('clamps native detection OFF down to ON when either selector changes, rather than refusing a valid callback', () => {
  const { panel } = fixture();
  panel.status[27] = 0x0f;
  const source = decodeStatus(panel.status);
  expect(control(source, { detectionOn: 1 })[27]).toBe(0x05);
  panel.status[27] = 1;
  expect(control(decodeStatus(panel.status), { detectionOff: 3 })[27]).toBe(0x05);
  expect(control(source, { detectionOn: 0, detectionOff: 3 })[27]).toBe(0);
  expect(control(source, { detectionOn: 1 })[23]).toBe(4);
  for (const value of [-1, 4, 1.5, NaN])
    expect(() => control(source, { detectionOff: value })).toThrow('0–3');
  expect(source.raw[27]).toBe(0x0f);
});

it('decodes the two native detection fields and reconstructs explicit single-field changes without treating reserved bits as OFF', () => {
  // Independent native fixtures: RX aa8251/aa8263 mask each field with3;
  // TX aa6642 packs only the two decoded indexes.
  for (const [raw, on, off, setOnThree, setOffZero] of [
    [0xf8, 0, 2, 0x0b, 0],
    [0xff, 3, 3, 0x0f, 3],
    [0xf1, 1, 0, 0x03, 1],
    [0x8e, 2, 3, 0x0f, 2],
  ]) {
    const { panel } = fixture();
    panel.status[27] = raw;
    const status = decodeStatus(panel.status);
    expect(settings(status)).toMatchObject({ detectionOn: on, detectionOff: off });
    expect(control(status, { detectionOn: 3 })[27]).toBe(setOnThree);
    expect(control(status, { detectionOff: 0 })[27]).toBe(setOffZero);
    expect(status.raw[27]).toBe(raw);
  }
});

describe('recovered display settings', () => {
  it('decodes independent OLED nibbles and the native non-linear standby selection', () => {
    const { panel } = fixture();
    expect(settings(decodeStatus(panel.status))).toMatchObject({
      oledMaximumBrightness: 11,
      oledDimmedBrightness: 2,
      standbyLedMode: 3,
    });
    for (let mode = 0; mode < 4; mode++) {
      panel.status[36] = 0xf0 | mode;
      expect(settings(decodeStatus(panel.status)).standbyLedMode).toBe(mode);
    }
  });

  it('packs all OLED values independently, preserving the other nibble and source bytes', () => {
    const { panel } = fixture(),
      source = decodeStatus(panel.status),
      before = source.raw.slice();
    for (let value = 0; value <= 15; value++) {
      const maximum = control(source, { oledMaximumBrightness: value }),
        dimmed = control(source, { oledDimmedBrightness: value });
      expect(maximum[35]).toBe((value << 4) | 2);
      expect(dimmed[35]).toBe(0xb0 | value);
      expect(maximum[36]).toBe(0xe3);
      expect(dimmed[36]).toBe(0xe3);
      expect(maximum[23]).toBe(8);
      expect(dimmed[23]).toBe(8);
    }
    expect(source.raw).toEqual(before);
  });

  it('preserves advanced-option bits except the known bit2 exclusion for every standby mode', () => {
    const { panel } = fixture();
    for (const mode of [0, 1, 2, 3] as const) {
      const target = control(decodeStatus(panel.status), { standbyLedMode: mode });
      expect(target[35]).toBe(0xb2);
      expect(target[36]).toBe(0xe0 | mode);
      expect(target[23]).toBe(8);
    }
  });

  it('reconstructs trigger bits only for explicit changes, including same-value and zero writes', () => {
    const { panel } = fixture();
    panel.status[23] = 255;
    const status = decodeStatus(panel.status);
    expect(control(status, { volume: -20 })[23]).toBe(0);
    expect(control(status, { oledMaximumBrightness: 11 })[23]).toBe(8);
    expect(control(status, { standbyLedMode: 0 })[23]).toBe(8);
    expect(control(status, { detectionOn: 2, detectionOff: 1, oledDimmedBrightness: 0 })[23]).toBe(
      12,
    );
    expect(hasDisplayControls({ oledMaximumBrightness: 0 })).toBe(true);
    expect(hasDisplayControls({ oledDimmedBrightness: 0 })).toBe(true);
    expect(hasDisplayControls({ standbyLedMode: 0 })).toBe(true);
    expect(hasDisplayControls({ volume: 0 })).toBe(false);
  });

  it('rejects non-integer and out-of-range display values before any control write', async () => {
    const { panel, session } = fixture();
    for (const field of ['oledMaximumBrightness', 'oledDimmedBrightness'] as const)
      for (const value of [-1, 16, 1.5, NaN, Infinity])
        await expect(session.setControls({ [field]: value })).rejects.toThrow(
          'integer from 0 to 15',
        );
    for (const value of [-1, 4, 1.5, NaN, Infinity])
      await expect(session.setControls({ standbyLedMode: value } as Controls)).rejects.toThrow(
        'Standby LED mode',
      );
    expect(controlWrites(panel)).toHaveLength(0);
  });

  it('requires fresh configuration bit0x10 for OLED, independently of RX status bits', async () => {
    const { panel, session } = fixture(false);
    panel.status[23] = 0x10;
    panel.configuration[4] = 0xef;
    await expect(session.setControls({ oledMaximumBrightness: 1 })).rejects.toThrow(
      'does not advertise OLED',
    );
    expect(controlWrites(panel)).toHaveLength(0);
    panel.configuration[4] |= 0x10;
    await session.setControls({ oledMaximumBrightness: 1 });
    expect(panel.status[35]).toBe(0x12);
    expect(panel.displayUpdates).toBe(1);
    panel.configuration[4] &= 0xef;
    await expect(session.setControls({ oledDimmedBrightness: 1 })).rejects.toThrow(
      'does not advertise OLED',
    );
    expect(controlWrites(panel)).toHaveLength(1);
  });

  it('allows standby LED without OLED while preserving unrelated fields and excluding bit2', async () => {
    const { panel, session } = fixture(false);
    panel.status[12] = 0x76;
    panel.status[27] = 5;
    const result = await session.setControls({ standbyLedMode: 2 });
    expect(result.raw[35]).toBe(0xb2);
    expect(result.raw[36]).toBe(0xe2);
    expect(result.raw[12]).toBe(0x76);
    expect(result.raw[27]).toBe(5);
    expect(panel.displayUpdates).toBe(1);
    expect(controlWrites(panel)[0][23]).toBe(8);
  });

  it('retains password refusal for OLED and standby writes', async () => {
    const { panel, session } = fixture();
    panel.status[51] = 2;
    for (const patch of [{ oledDimmedBrightness: 0 }, { standbyLedMode: 0 }] as Controls[]) {
      await expect(session.preflightControls(patch)).rejects.toThrow('password locked');
      await expect(session.setControls(patch)).rejects.toThrow('password locked');
    }
    expect(controlWrites(panel)).toHaveLength(0);
  });

  it('does not infer support from an amplifier name when fresh FA503/DSP gates fail', async () => {
    for (const change of [
      (p: SimulatedPanel) => (p.configuration[1] = 18),
      (p: SimulatedPanel) => (p.configuration[3] = 2),
      (p: SimulatedPanel) => (p.deviceConfiguration[10] = 4),
      (p: SimulatedPanel) => (p.deviceConfiguration[12] = 18),
    ]) {
      const { panel, session } = fixture();
      await session.identify();
      change(panel);
      await expect(session.setControls({ standbyLedMode: 1 })).rejects.toThrow();
      expect(controlWrites(panel)).toHaveLength(0);
    }
  });

  it('preflights both amps without writes when the second is unsupported or locked', async () => {
    for (const locked of [false, true]) {
      const left = fixture(),
        right = fixture(locked);
      if (locked) right.panel.status[51] = 2;
      const results = await Promise.allSettled(
        [left.session, right.session].map((session) =>
          session.preflightControls({ oledMaximumBrightness: 0 }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(controlWrites(left.panel)).toHaveLength(0);
      expect(controlWrites(right.panel)).toHaveLength(0);
    }
  });

  it('rechecks capability at the final write after successful read-only preflight', async () => {
    const { panel, session } = fixture();
    await session.preflightControls({ oledDimmedBrightness: 4 });
    panel.configuration[4] = 0;
    await expect(session.setControls({ oledDimmedBrightness: 4 })).rejects.toThrow(
      'does not advertise OLED',
    );
    expect(controlWrites(panel)).toHaveLength(0);
  });

  it('rechecks a newly locked panel at the final write after successful preflight', async () => {
    const { panel, session } = fixture();
    await session.preflightControls({ standbyLedMode: 0 });
    panel.status[51] = 2;
    await expect(session.setControls({ standbyLedMode: 0 })).rejects.toThrow('password locked');
    expect(controlWrites(panel)).toHaveLength(0);
  });

  it('preserves live volume and mute changes that occur during display identity reads', async () => {
    const { panel, session } = fixture(),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      if (request[0] === 6) {
        new DataView(panel.status.buffer).setInt16(3, -1875, true);
        panel.status[6] = 5;
        panel.status[12] = 0x76;
      }
      return exchange(request);
    };
    const result = await session.setControls({ oledMaximumBrightness: 3 });
    expect(result.volume).toBe(-18.75);
    expect(result.muted).toBe(false);
    expect(result.channelMutes).toEqual([true, false, true]);
    expect(result.raw[12]).toBe(0x76);
    expect(result.raw[35]).toBe(0x32);
    const writeIndex = panel.requests.findIndex((request) => request[0] === 5 && request[1] === 0);
    expect(panel.requests[writeIndex - 1].slice(0, 2)).toEqual(new Uint8Array([5, 1]));
  });

  it('detaches queued proposals so caller mutation cannot bypass the OLED capability check', async () => {
    for (const preflight of [false, true]) {
      const { panel, session } = fixture(false);
      let release!: () => void;
      const hold = session.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
      // Wait until the queue's first reservation has started.
      await Promise.resolve();
      const patch: Controls = { oledMaximumBrightness: 0 },
        attempt = preflight ? session.preflightControls(patch) : session.setControls(patch);
      delete patch.oledMaximumBrightness;
      patch.standbyLedMode = 1;
      release();
      await hold;
      await expect(attempt).rejects.toThrow('does not advertise OLED');
      expect(controlWrites(panel)).toHaveLength(0);
    }
  });

  it.each([35, 36])(
    'detects changed display or preserved advanced bits in readback byte%d',
    async (byte) => {
      const { panel, session } = fixture(),
        exchange = panel.exchange.bind(panel);
      panel.exchange = async (request) => {
        const response = await exchange(request);
        if (request[0] === 5 && request[1] === 0) response[byte] ^= byte === 35 ? 1 : 0x80;
        return response;
      };
      await expect(session.setControls({ standbyLedMode: 2 })).rejects.toThrow(
        `Control readback mismatch at byte ${byte}`,
      );
    },
  );

  it('ignores only the known advanced-option bit2 when verifying readback', async () => {
    const { panel, session } = fixture(),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const response = await exchange(request);
      if (request[0] === 5 && request[1] === 0) response[36] |= 4;
      return response;
    };
    await expect(session.setControls({ standbyLedMode: 1 })).resolves.toBeDefined();
    expect(controlWrites(panel)[0][36] & 4).toBe(0);
  });

  it('retains exact display bytes in backups and ordinary startup/volume changes', async () => {
    const { panel, session, backups } = fixture(),
      original = panel.status.slice();
    await session.backup(1);
    expect(backups[0].status_hex).toBe(hex(original));
    await session.setControls({ startupVolume: null, volume: -30, mute: true });
    expect(settings(decodeStatus(panel.status))).toMatchObject({
      startupVolume: -200,
      oledMaximumBrightness: 11,
      oledDimmedBrightness: 2,
      standbyLedMode: 3,
    });
    expect(panel.status[36]).toBe(0xe3);
    expect(panel.displayUpdates).toBe(0);
  });
});

describe('read-only hardware overview', () => {
  it('decodes numeric enums, boolean bits and signed/unsigned little-endian fields', () => {
    const { panel } = fixture();
    panel.configuration[4] = 0x96;
    panel.deviceConfiguration.set([5, 0x92, 22, 2, 0x81, 73, 0x80, 0xff, 0xfe, 0xca], 10);
    expect(decodeHardwareOverview(panel.configuration, panel.deviceConfiguration)).toEqual({
      systemSetup: 0x96,
      oledCapable: true,
      amplifier: 5,
      moduleType: 0x92,
      product: 22,
      thirdChannelEnabled: true,
      fanConnected: true,
      stereoDsp: true,
      temperatureSetpoint: 73,
      dspPeakSetpoint: -128,
      oledVersion: 0xcafe,
    });
    panel.deviceConfiguration[13] = 0;
    panel.deviceConfiguration[14] = 0x7e;
    panel.configuration[4] = 0xef;
    expect(decodeHardwareOverview(panel.configuration, panel.deviceConfiguration)).toMatchObject({
      oledCapable: false,
      thirdChannelEnabled: false,
      fanConnected: false,
      stereoDsp: false,
    });
  });

  it('handles typed-array offsets and rejects malformed/family-mismatched replies', () => {
    const { panel } = fixture(),
      config = new Uint8Array(70).subarray(3, 67),
      device = new Uint8Array(80).subarray(8, 72);
    config.set(panel.configuration);
    device.set(panel.deviceConfiguration);
    device[16] = 0x34;
    device[17] = 0x12;
    expect(decodeHardwareOverview(config, device).dspPeakSetpoint).toBe(0x1234);
    expect(() => decodeHardwareOverview(config.subarray(0, 63), device)).toThrow();
    expect(() => decodeHardwareOverview(config, device.subarray(0, 63))).toThrow();
    for (const [bytes, index] of [
      [config, 0],
      [config, 1],
      [config, 2],
      [config, 3],
      [device, 0],
      [device, 10],
      [device, 12],
    ] as const) {
      const value = bytes[index];
      bytes[index] = 0;
      expect(() => decodeHardwareOverview(config, device)).toThrow();
      bytes[index] = value;
    }
  });

  it('freshly reads overview under the session reservation without changing panel state', async () => {
    const { panel, session } = fixture(),
      originalStatus = panel.status.slice(),
      originalDevice = panel.deviceConfiguration.slice(),
      originalMemory = panel.memory.slice(),
      originalEeprom = panel.eeprom.slice();
    panel.deviceConfiguration[18] = 0x12;
    originalDevice[18] = 0x12;
    const [overview] = await Promise.all([session.hardwareOverview(), session.status()]);
    expect(overview.identity.serial).toBe(panel.serial);
    expect(overview.oledVersion).toBe(0x12);
    expect(overview.oledCapable).toBe(true);
    expect(panel.maxConcurrent).toBe(1);
    expect(panel.status).toEqual(originalStatus);
    expect(panel.deviceConfiguration).toEqual(originalDevice);
    expect(panel.memory).toEqual(originalMemory);
    expect(panel.eeprom).toEqual(originalEeprom);
    expect(controlWrites(panel)).toHaveLength(0);
    expect(panel.requests.every((r) => [6, 0x66, 3, 0x65, 5].includes(r[0]))).toBe(true);
    expect(panel.requests.filter((r) => r[0] === 0x66).every((r) => r[1] === 0)).toBe(true);
    panel.configuration[4] = 0;
    panel.deviceConfiguration[18] = 0x34;
    const updated = await session.hardwareOverview();
    expect(updated.oledVersion).toBe(0x34);
    expect(updated.oledCapable).toBe(false);
    overview.identity.name = 'detached';
    expect(session.identity?.name).toBe('Simulator');
  });
});
