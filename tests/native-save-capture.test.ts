// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { packet, hex } from '../src/hardware/codec';
import type { Transport } from '../src/hardware/transport';
import {
  captureNativeSaveTemplate,
  nativeSaveFilenameAddresses,
  type NativeSaveSnapshot,
} from '../src/hardware/native-save-capture';
import { captureNativeCloneTemplate } from '../src/hardware/clone-capture';

const addressOf = (r: Uint8Array) => r[2] | (r[3] << 8) | (r[4] << 16);
const stringBytes = (text: string) => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(text));
  return bytes;
};
/** Independent wire fixture: unity Q24 coefficients, nine metadata records,
 * and literal CRCs calculated separately with polynomial0x1021/init0xffff.
 * Deliberately different physical pages expose bank swaps and staged-EQ reuse. */
function literalEq(preset: 1 | 2 | 3): Uint8Array {
  const bytes = new Uint8Array(256).fill(255),
    view = new DataView(bytes.buffer),
    p = preset - 1;
  for (let band = 0; band < 9; band++) {
    for (let word = 0; word < 5; word++)
      view.setInt32(band * 20 + word * 4, word === 2 ? 16777216 : 0, true);
    const offset = 180 + band * 8,
      frequency = ([444, 1234, 5678][p] + band) * 100;
    bytes[offset] = band === 0 ? 128 | p : 0;
    bytes[offset + 1] = frequency & 255;
    bytes[offset + 2] = (frequency >> 8) & 255;
    bytes[offset + 3] = frequency >> 16;
    view.setUint16(offset + 4, [500, 750, 900][p], true);
    view.setInt16(offset + 6, [1000, -2000, 3000][p], true);
  }
  view.setUint16(254, [0x4bab, 0xafbc, 0x6d74][p], true);
  return bytes;
}
function fixture() {
  const panel = new SimulatedPanel('H05U-SYNTHETIC-NATIVE-SAVE'),
    trace: Uint8Array[] = [],
    mixer = packet(0x67),
    backup = vi.fn(async () => {
      throw new Error('Native Save must not persist hardware backups');
    });
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 9;
  panel.deviceConfiguration[13] = 1;
  panel.deviceConfiguration[14] = 129;
  panel.status[31] = 2; // P1 input, P2 output, P3 input.
  panel.status.set([16, 0, 16], 12); // Physical whole-EQ activation is independent.
  panel.status[50] = 4;
  new DataView(panel.status.buffer).setInt16(52, -1234, true);
  panel.eeprom.set(stringBytes('FA503 synthetic'), 0x120);
  panel.eeprom.set(stringBytes('OEM synthetic'), 0x140);
  for (let p = 0; p < 3; p++)
    for (let n = 0; n < 4; n++)
      panel.eeprom.set(stringBytes(`P${p + 1}-${n}.txt`), 0x200 + p * 128 + n * 32);
  for (const p of [1, 2, 3] as const) panel.memory.set(literalEq(p), 0x24000 + p * 4096);
  const mv = new DataView(mixer.buffer);
  [-256, 128, 256, -1, 0, 255, ...Array.from({ length: 12 }, (_, i) => i * 16)].forEach((word, i) =>
    mv.setInt16(2 + i * 2, word, true),
  );
  let intercept:
    ((request: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>) | undefined;
  const transport: Transport = {
      exchange: async (request) => {
        trace.push(request.slice());
        const send = () =>
          request[0] === 0x67 ? Promise.resolve(mixer.slice()) : panel.exchange(request);
        return intercept ? intercept(request, send) : send();
      },
      close: () => panel.close(),
    },
    session = new PanelSession(transport, backup),
    identity = { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' },
    capture = () => session.exclusive(() => session.captureNativeSaveSnapshotInternal(identity));
  return {
    panel,
    session,
    mixer,
    trace,
    backup,
    identity,
    capture,
    set intercept(value: typeof intercept) {
      intercept = value;
    },
  };
}

it('captures a double-read-matched physical info snapshot using only metadata and three EQ pages, never IIR/FIR data or setters', async () => {
  const f = fixture(),
    memory = f.panel.memory.slice(),
    eeprom = f.panel.eeprom.slice(),
    status = f.panel.status.slice(),
    raw = await f.capture();
  expect(raw.eqPages.map(({ preset, address, bytes }) => [preset, address, hex(bytes)])).toEqual(
    ([1, 2, 3] as const).map((p) => [p, 0x24000 + p * 4096, hex(literalEq(p))]),
  );
  expect(raw.filenames.map((x) => x.address)).toEqual([0x200, 0x2a0, 0x2c0, 0x2e0, 0x300]);
  expect(f.trace.filter((r) => r[0] === 6)).toHaveLength(2);
  expect(f.trace.filter((r) => r[0] === 0x67)).toHaveLength(2);
  const selected = new Set([0x100, 0x120, 0x140, ...raw.filenames.map((x) => x.address)]);
  for (const r of f.trace) {
    if (r[0] === 0x65) {
      expect(r[1]).toBe(32);
      const a = addressOf(r);
      if (r[5] === 0) expect(selected.has(a)).toBe(true);
      else {
        expect(r[5]).toBe(1);
        expect(
          [0x25000, 0x26000, 0x27000].some((base) => a >= base && a < base + 256 && a % 32 === 0),
        ).toBe(true);
      }
    } else
      expect([
        [6, 1],
        [0x66, 0],
        [5, 1],
        [3, 8],
        [0x67, 0],
      ]).toContainEqual([r[0], r[1]]);
  }
  expect(f.trace.filter((r) => r[0] === 0x65 && r[5] === 1)).toHaveLength(48);
  expect(hex(f.panel.memory)).toBe(hex(memory));
  expect(hex(f.panel.eeprom)).toBe(hex(eeprom));
  expect(hex(f.panel.status)).toBe(hex(status));
  expect(f.backup).not.toHaveBeenCalled();
  expect(f.panel.writes).toBe(0);
  expect(f.panel.eqReloads).toBe(0);
});

it('maps independently identified physical EQ, runtime values and selected filenames with honest fresh-host defaults on a locked source', async () => {
  const f = fixture();
  f.panel.status[51] = 2;
  const raw = await f.capture(),
    before = JSON.stringify(raw),
    captured = captureNativeSaveTemplate(raw, '2026-11-15T12:00:00.000Z');
  expect(captured.eqBanks.map((p) => p[0])).toEqual([
    { filterType: 0, enabled: true, frequency: 444, q: 0.5, gain: 1 },
    { filterType: 1, enabled: true, frequency: 1234, q: 0.75, gain: -2 },
    { filterType: 2, enabled: true, frequency: 5678, q: 0.9, gain: 3 },
  ]);
  expect(captured.settings.presets.map((p) => p.eqEnabled)).toEqual([true, false, true]);
  expect(captured.settings).toMatchObject({
    activeInput: 4,
    actualVolume: Math.fround(-12.34),
    passwordProtected: true,
  });
  expect(captured.configuration.mixer[0]).toEqual([-1, 0.5, 1, -1 / 256, 0, 255 / 256]);
  expect(captured.settings.presets[0].inputFir.filename).toBe('P1-0.txt');
  expect(captured.settings.presets[1].outputFirs.map((f) => f.filename)).toEqual([
    'P2-1.txt',
    'P2-2.txt',
    'P2-3.txt',
  ]);
  expect(captured.provenance.captureDefaults).toContain('settings.presets.1.inputFir.filename');
  expect(captured.provenance.captureDefaults).toContain('settings.gainCorrection12');
  expect(JSON.stringify(raw)).toBe(before);
  f.panel.memory.fill(0);
  f.panel.eeprom.fill(0);
  f.mixer.fill(0);
  expect(raw.eqPages[1].bytes[254]).toBe(0xbc);
  expect(captured.configuration.hypexName).toBe('FA503 synthetic');
});

it('shares the exact pure projection with existing full Clone capture without weakening Clone backup validation', async () => {
  const f = fixture(),
    raw = await f.capture(),
    full = {
      ...raw,
      flash: Array.from({ length: 24 }, (_, i) => ({
        address: 0x10000 + i * 4096,
        bytes: f.panel.memory.slice(0x10000 + i * 4096, 0x11000 + i * 4096),
      })),
      filenames: Array.from({ length: 12 }, (_, i) => ({
        address: 0x200 + i * 32,
        bytes: f.panel.eeprom.slice(0x200 + i * 32, 0x220 + i * 32),
      })),
    };
  expect(captureNativeCloneTemplate(full)).toEqual(captureNativeSaveTemplate(raw));
  full.flash.pop();
  expect(() => captureNativeCloneTemplate(full)).toThrow('every ordered');
});

it.each([
  'EQ missing',
  'EQ order',
  'EQ address',
  'EQ short',
  'EQ CRC',
  'FIR missing',
  'FIR inactive extra',
  'FIR short',
  'FIR address',
  'mixer missing',
  'foreign serial',
  'missing count',
] as const)(
  'rejects %s in the narrow pure snapshot without substitution or input mutation',
  async (reason) => {
    const f = fixture(),
      raw = await f.capture();
    if (reason === 'EQ missing') raw.eqPages.pop();
    if (reason === 'EQ order') raw.eqPages.reverse();
    if (reason === 'EQ address') raw.eqPages[0].address = 0x22000;
    if (reason === 'EQ short') raw.eqPages[0].bytes = raw.eqPages[0].bytes.slice(1);
    if (reason === 'EQ CRC') raw.eqPages[1].bytes[180] ^= 1;
    if (reason === 'FIR missing') raw.filenames.pop();
    if (reason === 'FIR inactive extra')
      raw.filenames.push({ address: 0x220, bytes: new Uint8Array(32) });
    if (reason === 'FIR short') raw.filenames[0].bytes = raw.filenames[0].bytes.slice(1);
    if (reason === 'FIR address') raw.filenames[0].address = 0x220;
    if (reason === 'mixer missing') raw.mixerConfiguration = new Uint8Array(0);
    if (reason === 'foreign serial') raw.identity.serial = 'FOREIGN';
    if (reason === 'missing count') raw.configuration[12] = 0;
    const before = JSON.stringify(raw);
    expect(() => captureNativeSaveTemplate(raw)).toThrow();
    expect(JSON.stringify(raw)).toBe(before);
  },
);

it.each([
  'actual input',
  'actual volume',
  'protection',
  'configuration',
  'device configuration',
  'mixer',
  'DSP name',
  'serial',
  'product string',
  'FIR name',
  'placement',
  'valid EQ change',
] as const)('rejects a changed %s between passes before returning metadata', async (field) => {
  const f = fixture();
  let pass = 0;
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x65 && addressOf(r) === 0x270e0 && ++pass === 1) {
      if (field === 'actual input') f.panel.status[50] ^= 1;
      if (field === 'actual volume') f.panel.status[52] ^= 1;
      if (field === 'protection') f.panel.status[51] ^= 2;
      if (field === 'configuration') f.panel.configuration[4] ^= 2;
      if (field === 'device configuration') f.panel.deviceConfiguration[15] ^= 1;
      if (field === 'mixer') f.mixer[2] ^= 1;
      if (field === 'DSP name') f.panel.name = 'Changed name';
      if (field === 'serial') f.panel.eeprom[0x100] ^= 1;
      if (field === 'product string') f.panel.eeprom[0x120] ^= 1;
      if (field === 'FIR name') f.panel.eeprom[0x200] ^= 1;
      if (field === 'placement') f.panel.status[31] ^= 1;
      if (field === 'valid EQ change') f.panel.memory.set(literalEq(3), 0x26000);
    }
    return reply;
  };
  await expect(f.capture()).rejects.toThrow(/changed/);
  expect(f.backup).not.toHaveBeenCalled();
  expect(f.panel.writes).toBe(0);
});

it('checks final runtime identity/settings after the second EQ read instead of ending on an old header', async () => {
  const f = fixture();
  let lastPage = 0;
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x65 && addressOf(r) === 0x270e0 && ++lastPage === 2) f.panel.status[52] ^= 1;
    return reply;
  };
  await expect(f.capture()).rejects.toThrow('changed');
  const lastEq = f.trace.findLastIndex((r) => r[0] === 0x65 && r[5] === 1);
  expect(f.trace.slice(lastEq + 1).some((r) => r[0] === 6)).toBe(true);
  expect(f.trace.slice(lastEq + 1).some((r) => r[0] === 5)).toBe(true);
});

it('allows changing nonserialized signal/matched/telemetry and channel-mute fields without inventing saved state', async () => {
  const f = fixture();
  let pass = 0;
  f.intercept = async (r, send) => {
    if (r[0] === 6 && ++pass === 2) {
      f.panel.status[51] ^= 5;
      f.panel.status[54] ^= 1;
      f.panel.status[6] ^= 1;
    }
    return send();
  };
  const raw = await f.capture();
  expect(captureNativeSaveTemplate(raw).settings.passwordProtected).toBe(false);
});

it.each([
  'missing filename',
  'short filename reply',
  'wrong filename command',
  'bad EQ CRC',
] as const)('rejects a %s read without silently padding or falling back', async (fault) => {
  const f = fixture();
  f.intercept = async (r, send) => {
    if (r[0] === 0x65 && addressOf(r) === 0x200) {
      if (fault === 'missing filename') throw new Error('Synthetic missing filename');
      if (fault === 'short filename reply') return Uint8Array.of(0x65, 32, 1, 2);
      if (fault === 'wrong filename command') return packet(0x66, 32);
    }
    if (fault === 'bad EQ CRC' && r[0] === 0x65 && addressOf(r) === 0x260a0) {
      const reply = await send();
      reply[22] ^= 1;
      return reply;
    }
    return send();
  };
  await expect(f.capture()).rejects.toThrow();
  expect(f.panel.writes).toBe(0);
  expect(f.backup).not.toHaveBeenCalled();
});

it('rejects a stale expected identity before reading EQ data, and invalid identity before any request', async () => {
  const f = fixture();
  await expect(
    f.session.exclusive(() =>
      f.session.captureNativeSaveSnapshotInternal({ ...f.identity, serial: 'OTHER' }),
    ),
  ).rejects.toThrow('identity');
  expect(f.trace.some((r) => r[0] === 0x65 && r[5] === 1)).toBe(false);
  f.trace.length = 0;
  await expect(
    f.session.exclusive(() =>
      f.session.captureNativeSaveSnapshotInternal({ ...f.identity, serial: '' }),
    ),
  ).rejects.toThrow('explicit');
  expect(f.trace).toHaveLength(0);
});
