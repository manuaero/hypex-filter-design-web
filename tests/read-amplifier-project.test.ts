import { beforeEach, expect, it, vi } from 'vitest';
import { readAmplifierProject } from '../src/application/read-amplifier-project';
import { newProject } from '../src/domain/model';
import { compileSector } from '../src/domain/dsp';
import { decodeEq, encodeEq, hex, packet, presetBase } from '../src/hardware/codec';
import { encodeFir, firLayout, type FirBackup } from '../src/hardware/fir';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { Transport } from '../src/hardware/transport';

const savedFir = vi.hoisted(() => [] as FirBackup[]);
vi.mock('../src/hardware/storage', async (original) => ({
  ...(await original<typeof import('../src/hardware/storage')>()),
  saveFirBackup: async (backup: FirBackup) => {
    savedFir.push(structuredClone(backup));
  },
}));
beforeEach(() => {
  savedFir.length = 0;
});

const address = (request: Uint8Array) => request[2] | (request[3] << 8) | (request[4] << 16);
function fixture() {
  const panel = new SimulatedPanel('H05U-SYNTHETIC-READ-PROJECT'),
    backups: Backup[] = [],
    trace: Uint8Array[] = [];
  panel.name = 'Synthetic current filters';
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 9;
  panel.status[2] = 3;
  panel.status[6] = 0; // Auditing an unmuted panel catches an automatic mute.
  panel.status.set([16, 0, 16], 12);
  panel.status[31] = 2; // P1 input, P2 output, P3 input.
  panel.status.set([0x88, 0x32, 8], 28);
  const input = Array.from({ length: 4500 }, (_, i) => (i === 0 ? 0.5 : i === 4499 ? 0.25 : 0)),
    outputs = [0.25, -0.5].map((value) =>
      Array.from({ length: 1500 }, (_, i) => (i === 7 ? value : 0)),
    );
  panel.memory.set(encodeFir(input, 4500), firLayout(1).base);
  panel.memory.set(encodeFir(outputs[0], 1500), firLayout(2).outputs[0]);
  panel.memory.set(encodeFir(outputs[1], 1500), firLayout(2).outputs[1]);
  for (const p of [1, 2, 3]) {
    const preset = newProject().presets[p - 1];
    preset.inputEq[0].enabled = true;
    preset.inputEq[0].frequency = 300 + p * 100;
    preset.inputEq[0].gain = p;
    panel.memory.set(encodeEq(preset.inputEq), presetBase(p) + 0x3000);
    const view = new DataView(panel.memory.buffer);
    for (let c = 0; c < 3; c++) {
      const base = presetBase(p) + c * 512;
      view.setUint32(base, p * 100 + c * 7, true);
      for (let i = 0; i < 15; i++)
        [p * 100 + c * 10 + i, 0, 16777216 - p * 1000 - c * 100 - i, 0, 0].forEach((word, j) =>
          view.setInt32(base + 4 + i * 20 + j * 4, word, true),
        );
    }
    for (const [i, start] of firLayout(p).names.entries()) {
      const bytes = new Uint8Array(32);
      bytes.set(new TextEncoder().encode(`Preset${p}-bank${i}.txt`));
      panel.eeprom.set(bytes, start);
    }
  }
  let intercept: ((request: Uint8Array) => void) | undefined;
  const transport: Transport = {
    exchange: async (request) => {
      const allowed =
        request.length === 64 &&
        ((request[0] === 6 && request[1] === 1) ||
          (request[0] === 0x66 && request[1] === 0) ||
          (request[0] === 3 && request[1] === 8) ||
          (request[0] === 5 && request[1] === 1) ||
          (request[0] === 0x67 && request[1] === 0) ||
          (request[0] === 0x65 &&
            request[1] > 0 &&
            request[1] <= 32 &&
            [0, 1].includes(request[5])));
      if (!allowed) throw new Error('Read-only transport refused an amplifier setter');
      trace.push(request.slice());
      intercept?.(request);
      return request[0] === 0x67 ? packet(0x67) : panel.exchange(request);
    },
    close: () => panel.close(),
  };
  const session = new PanelSession(transport, async (backup) => {
      backups.push(structuredClone(backup));
    }),
    identity = { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' };
  return {
    panel,
    session,
    identity,
    backups,
    trace,
    input,
    outputs,
    set intercept(fn: typeof intercept) {
      intercept = fn;
    },
  };
}
const untouched = (f: ReturnType<typeof fixture>) => ({
  memory: hex(f.panel.memory),
  eeprom: hex(f.panel.eeprom),
  status: hex(f.panel.status),
  configuration: hex(f.panel.configuration),
  deviceConfiguration: hex(f.panel.deviceConfiguration),
  name: f.panel.name,
  power: f.panel.powerMode,
  noise: f.panel.noiseRequested,
});

it('loads all three independent physical designs, EQ, selected FIR placements and settings with zero setters or physical changes', async () => {
  const f = fixture(),
    before = untouched(f),
    result = await readAmplifierProject(f.session, f.identity);
  expect(result.project.name).toBe(f.panel.name);
  expect(result.project.sampleRate).toBe(93750);
  expect(result.project.hfdSelectedPreset).toBe(3);
  expect(result.identity).toMatchObject({ ...f.identity, name: f.panel.name });
  expect(result.status).toMatchObject({ preset: 3, muted: false });
  expect(result.project.hfdCloneTemplate?.settings.selectedPreset).toBe(3);
  expect(result.project.hfdCloneTemplate?.eqBanks.map((bands) => bands[0].frequency)).toEqual([
    400, 500, 600,
  ]);
  expect(result.project.presets.map((p) => p.eqEnabled)).toEqual([true, false, true]);
  expect(result.project.presets[0].channels.map((c) => c.name)).toEqual([
    'Output 1',
    'Output 2',
    'Output 3',
  ]);
  expect(result.backups.crossover).toHaveLength(3);
  expect(result.backups.fir).toHaveLength(3);
  expect(f.backups.map((b) => b.address)).toEqual([0x22000, 0x23000, 0x24000]);
  expect(savedFir.map((b) => b.preset)).toEqual([1, 2, 3]);
  for (const [index, preset] of result.project.presets.entries()) {
    const physical = f.panel.memory.slice(presetBase(index + 1), presetBase(index + 1) + 4096);
    const encoded = compileSector(preset, physical);
    for (let channel = 0; channel < 3; channel++)
      expect(encoded.slice(channel * 512, channel * 512 + 304)).toEqual(
        physical.slice(channel * 512, channel * 512 + 304),
      );
    expect(result.backups.crossover[index].sector_hex).toBe(hex(physical));
    expect(
      preset.channels.every((channel) =>
        channel.filters.every((filter) => filter.kind === 'raw' && filter.provenance === 'panel'),
      ),
    ).toBe(true);
    expect(
      preset.channels.every(
        (channel) => channel.measurement === undefined && channel.linkedTo === undefined,
      ),
    ).toBe(true);
    const expected = decodeEq(
      f.panel.memory.slice(presetBase(index + 1) + 0x3000, presetBase(index + 1) + 0x3100),
    );
    expect(preset.inputEq.map(({ id, ...band }) => band)).toEqual(
      expected.map(({ id, ...band }) => band),
    );
  }
  expect(result.project.presets[0].inputFir.taps).toEqual(f.input);
  expect(result.project.presets[1].channels[0].fir.taps).toEqual(f.outputs[0]);
  expect(result.project.presets[1].channels[1].fir.taps).toEqual(f.outputs[1]);
  expect(result.project.presets[1].channels[0].fir.enabled).toBe(false);
  expect(result.project.presets[1].channels[1].fir.enabled).toBe(true);
  expect(result.project.presets[2].inputFir).toMatchObject({
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 4500 },
  });
  expect(result.project.presets[0].channels[0].fir).toMatchObject({
    name: 'Preset1-bank1.txt',
    taps: [],
    hfdState: { used: false, loaded: false },
  });
  expect(result.project.warnings.join(' ')).toContain('Original filter shapes');
  expect(result.project.sourceXml).toBeUndefined();
  expect(untouched(f)).toEqual(before);
  expect(f.panel.writes + f.panel.eqReloads + f.panel.mixerWrites + f.panel.noiseRequests).toBe(0);
  expect(f.trace.some((r) => r[0] === 0x65 && address(r) === 0x10000)).toBe(true);
  expect(f.panel.maxConcurrent).toBe(1);
});

it.each(['support', 'input-capacity', 'output-capacity', 'mode'] as const)(
  'refuses unsupported FIR %s before reading any coefficient sector',
  async (reason) => {
    const f = fixture(),
      view = new DataView(f.panel.configuration.buffer);
    if (reason === 'support') f.panel.configuration[14] = 0;
    if (reason === 'input-capacity') view.setUint16(50, 4499, true);
    if (reason === 'output-capacity') view.setUint16(54, 1499, true);
    if (reason === 'mode') f.panel.status[10] |= 32;
    const before = untouched(f);
    await expect(readAmplifierProject(f.session, f.identity)).rejects.toThrow(/4500\/1500-tap/);
    expect(f.backups).toEqual([]);
    expect(savedFir).toEqual([]);
    expect(
      f.trace
        .filter((r) => r[0] === 0x65 && r[5] === 1)
        .every((r) =>
          [0x25000, 0x26000, 0x27000].some((base) => address(r) >= base && address(r) < base + 256),
        ),
    ).toBe(true);
    expect(untouched(f)).toEqual(before);
  },
);

it('refuses an unqualified expected identity before any transport call', async () => {
  const f = fixture();
  await expect(readAmplifierProject(f.session, { ...f.identity, core: '5.5' })).rejects.toThrow(
    /explicit captured FA503 identity/,
  );
  expect(f.trace).toEqual([]);
});

it('stale workspace context during a bank read returns no project and starts no following FIR read', async () => {
  const f = fixture();
  let current = true;
  f.intercept = (r) => {
    if (r[0] === 0x65 && r[5] === 1 && address(r) === 0x22000) current = false;
  };
  await expect(
    readAmplifierProject(f.session, f.identity, {
      assertCurrent: () => {
        if (!current) throw Error('Retired role');
      },
    }),
  ).rejects.toThrow('Retired role');
  expect(f.backups).toHaveLength(1);
  expect(savedFir).toEqual([]);
  expect(f.trace.some((r) => r[0] === 0x65 && r[5] === 1 && address(r) < 0x22000)).toBe(false);
  expect(f.panel.writes).toBe(0);
});

it('an incomplete later bank aborts the complete result while retaining completed local recovery copies', async () => {
  const f = fixture(),
    before = untouched(f);
  f.intercept = (r) => {
    if (r[0] === 0x65 && r[5] === 1 && address(r) === 0x23000) throw Error('Interrupted read');
  };
  await expect(readAmplifierProject(f.session, f.identity)).rejects.toThrow('Interrupted read');
  expect(f.backups).toHaveLength(1);
  expect(savedFir).toHaveLength(1);
  expect(untouched(f)).toEqual(before);
});

it('a physical settings change during the read refuses the design rather than returning mixed snapshots', async () => {
  const f = fixture();
  let changed = false;
  f.intercept = (r) => {
    if (!changed && r[0] === 0x65 && r[5] === 1 && address(r) === 0x22000) {
      changed = true;
      f.panel.status[15] ^= 1; // External preset-offset change, never a setter.
    }
  };
  await expect(readAmplifierProject(f.session, f.identity)).rejects.toThrow(
    /changed during the read/,
  );
  expect(f.panel.writes).toBe(0);
});

it('rejects an asynchronous context fence before any physical request', async () => {
  const f = fixture();
  await expect(
    readAmplifierProject(f.session, f.identity, { assertCurrent: async () => {} }),
  ).rejects.toThrow(/synchronously/);
  expect(f.trace).toEqual([]);
});
