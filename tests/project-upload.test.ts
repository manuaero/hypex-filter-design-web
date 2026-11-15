import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileSector } from '../src/domain/dsp';
import { newProject, type Preset } from '../src/domain/model';
import { decodeStatus, hex, presetBase, unhex } from '../src/hardware/codec';
import { encodeFir, firLayout } from '../src/hardware/fir';
import {
  ProjectUploadError,
  uploadProjectPair,
  type ProjectUploadJob,
} from '../src/hardware/project-upload';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { saveConfigurationBackup, saveFirBackup } from '../src/hardware/storage';

vi.mock('../src/hardware/storage', () => ({
  saveConfigurationBackup: vi.fn(async () => {}),
  saveFirBackup: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.mocked(saveConfigurationBackup).mockReset().mockResolvedValue(undefined);
  vi.mocked(saveFirBackup).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function fixture(serial: string, presets = newProject(serial).presets) {
  const panel = new SimulatedPanel(serial),
    backups: Backup[] = [],
    session = new PanelSession(panel, async (b) => {
      backups.push(structuredClone(b));
    }),
    job: ProjectUploadJob = { session, presets, name: `${serial} project`, label: serial };
  return { panel, backups, session, job };
}

const mutates = (r: Uint8Array) =>
  r[0] === 0x64 || ((r[0] === 5 || r[0] === 3) && r[1] === 0) || (r[0] === 0x66 && r[1] === 1);

/** Advance only simulated flash waits; WebCrypto still gets real event-loop
 * turns. No USB or hardware transport is used in this file. */
async function finish<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  const result = operation.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  for (let i = 0; !done && i < 5000; i++) {
    await vi.runAllTimersAsync();
    await yieldEventLoop();
  }
  if (!done) throw new Error('Simulator upload did not settle');
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function expectIir(panel: SimulatedPanel, presets: Preset[], original: Uint8Array) {
  presets.forEach((design, i) => {
    const base = presetBase(i + 1);
    expect(panel.memory.slice(base, base + 4096)).toEqual(
      compileSector(design, original.slice(base, base + 4096)),
    );
  });
}

describe('whole-project IIR/FIR upload', () => {
  it('backs up every preset and shared state before any mutation, verifies both mutes before erase, and restores each starting preset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const left = fixture('Left'),
      right = fixture('Right'),
      progress: { percent: number; text: string }[] = [];
    left.panel.status[2] = 2;
    right.panel.status[2] = 3;
    left.panel.status[6] = 5;
    right.panel.status[6] = 2;
    for (const [role, f] of [left, right].entries())
      f.job.presets.forEach((p, n) => {
        p.channels[0].gain = -(role * 6 + n + 1);
        p.channels[1].delayUs = n * 100;
        const base = presetBase(n + 1);
        f.panel.memory.fill(0xa0 + role + n, base + 1536, base + 4096);
      });
    left.job.progress = (percent, text) => progress.push({ percent, text });
    const originals = [left.panel.memory.slice(), right.panel.memory.slice()],
      designs = [structuredClone(left.job.presets), structuredClone(right.job.presets)];
    // Mutating the caller's design after preparation begins cannot change a
    // later preset or either role's frozen upload contents.
    const saveLeft = left.session.saveBackup;
    Object.defineProperty(left.session, 'saveBackup', {
      value: async (b: Backup) => {
        await saveLeft(b);
        left.job.presets[2].channels[0].gain = -30;
      },
    });
    for (const [f, other] of [
      [left, right],
      [right, left],
    ]) {
      const exchange = f.panel.exchange.bind(f.panel);
      f.panel.exchange = async (request) => {
        if (mutates(request)) {
          expect(left.backups).toHaveLength(3);
          expect(right.backups).toHaveLength(3);
          expect(saveConfigurationBackup).toHaveBeenCalledTimes(2);
          expect(saveFirBackup).toHaveBeenCalledTimes(6);
          expect(left.session.busy && right.session.busy).toBe(true);
        }
        if (request[0] === 0x64 && request[1] === 4)
          expect(decodeStatus(other.panel.status).muted).toBe(true);
        return exchange(request);
      };
    }
    await finish(uploadProjectPair([left.job, right.job]));
    expectIir(left.panel, designs[0], originals[0]);
    expectIir(right.panel, designs[1], originals[1]);
    for (const [i, f] of [left, right].entries()) {
      expect(f.panel.memory.slice(0x10000, 0x22000)).toEqual(originals[i].slice(0x10000, 0x22000));
      expect(f.panel.name).toBe(f.job.name);
      expect(f.panel.maxConcurrent).toBe(1);
      expect(f.session.busy).toBe(false);
      expect(decodeStatus(f.panel.status).muted).toBe(true);
      f.backups.forEach((b) => {
        expect(b.sector_hex).toBe(hex(originals[i].slice(b.address, b.address + 4096)));
        expect(b.configuration_hex).toBe(hex(f.panel.configuration));
      });
    }
    for (const [b] of vi.mocked(saveFirBackup).mock.calls) {
      const i = b.serial === 'Left' ? 0 : 1;
      expect(b.sectors).toHaveLength(6);
      expect(b.filenames).toHaveLength(4);
      b.sectors.forEach((s) =>
        expect(s.hex).toBe(hex(originals[i].slice(s.address, s.address + 4096))),
      );
    }
    expect(left.panel.status[2]).toBe(2);
    expect(right.panel.status[2]).toBe(3);
    expect(left.panel.status[6] & 7).toBe(5);
    expect(right.panel.status[6] & 7).toBe(2);
    expect(progress.filter((p) => /Preset [123]\/3 · verified · muted$/.test(p.text))).toHaveLength(
      3,
    );
    expect(progress.at(-1)?.percent).toBe(100);
    expect(progress.every((p, i) => i === 0 || p.percent >= progress[i - 1].percent)).toBe(true);
  });

  it('rejects late IIR or FIR validation failures without even muting either amp', async () => {
    for (const failure of ['IIR', 'FIR']) {
      const left = fixture(`L-${failure}`),
        right = fixture(`R-${failure}`);
      left.panel.status[6] = right.panel.status[6] = 0;
      if (failure === 'IIR') right.job.presets[2].channels[2].delayUs = -1;
      else right.job.presets[2].inputFir = { name: 'invalid', enabled: true, taps: [1] };
      const error = await uploadProjectPair([left.job, right.job]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectUploadError);
      const result = (error as ProjectUploadError).results[1];
      expect(result.presets.map((p) => p.state)).toEqual(['pending', 'pending', 'failed']);
      expect(result.presets[2].phase).toBe('preflight');
      expect(String(error)).toContain('Nothing programmed');
      for (const f of [left, right]) {
        expect(f.panel.requests.filter(mutates)).toHaveLength(0);
        expect(decodeStatus(f.panel.status).muted).toBe(false);
        expect(f.session.busy).toBe(false);
      }
    }
  });

  it.each([0, 4, 255])(
    'rejects invalid starting active preset %i in preflight without any writes',
    async (preset) => {
      const left = fixture('Left'),
        right = fixture('Right');
      right.panel.status[2] = preset;
      const error = await uploadProjectPair([left.job, right.job]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectUploadError);
      expect(String(error)).toContain('Invalid panel status');
      expect(String(error)).toContain('Nothing programmed');
      expect(
        (error as ProjectUploadError).results
          .flatMap((r) => r.presets)
          .every((p) => p.state === 'pending'),
      ).toBe(true);
      expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
    },
  );

  it.each(['shared configuration', 'third IIR', 'third FIR'])(
    'performs no writes if the %s backup cannot be persisted',
    async (failure) => {
      const left = fixture('Left'),
        right = fixture('Right');
      if (failure === 'shared configuration')
        vi.mocked(saveConfigurationBackup).mockImplementation(async (b) => {
          if (b.serial === 'Right') throw new Error('storage full');
        });
      if (failure === 'third FIR')
        vi.mocked(saveFirBackup).mockImplementation(async (b) => {
          if (b.serial === 'Right' && b.preset === 3) throw new Error('storage full');
        });
      if (failure === 'third IIR')
        Object.defineProperty(right.session, 'saveBackup', {
          value: async (b: Backup) => {
            if (b.preset === 3) throw new Error('storage full');
          },
        });
      await expect(uploadProjectPair([left.job, right.job])).rejects.toThrow('storage full');
      expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
    },
  );

  it('holds every reservation until all preparation settles, including after another role fails validation', async () => {
    const left = fixture('Left'),
      right = fixture('Right');
    left.job.presets[2].channels[0].delayUs = -1;
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(saveFirBackup).mockImplementation(async (b) => {
      if (b.serial === 'Right' && b.preset === 3) {
        reached();
        await held;
      }
    });
    const operation = uploadProjectPair([left.job, right.job]).catch((e: unknown) => e);
    await ready;
    expect(left.session.busy && right.session.busy).toBe(true);
    const entered: string[] = [],
      queued = [left, right].map((f) =>
        f.session.exclusive(async () => void entered.push(f.job.label!)),
      );
    await yieldEventLoop();
    expect(entered).toEqual([]);
    release();
    expect(await operation).toBeInstanceOf(ProjectUploadError);
    await Promise.all(queued);
    expect(entered.sort()).toEqual(['Left', 'Right']);
    expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
  });

  it('rejects duplicate session objects and duplicate physical serials before any write', async () => {
    const a = fixture('Same'),
      b = fixture('Same');
    await expect(uploadProjectPair([a.job, a.job])).rejects.toThrow('distinct amplifier');
    expect(a.panel.requests).toHaveLength(0);
    await expect(uploadProjectPair([a.job, b.job])).rejects.toThrow('same physical amplifier');
    expect([...a.panel.requests, ...b.panel.requests].filter(mutates)).toHaveLength(0);
  });

  it('does not program either panel if the pair mute barrier cannot be verified', async () => {
    const left = fixture('Left'),
      right = fixture('Right');
    left.panel.status[6] = right.panel.status[6] = 0;
    const exchange = right.panel.exchange.bind(right.panel);
    right.panel.exchange = async (request) => {
      if (request[0] === 5 && request[1] === 0) {
        right.panel.requests.push(request.slice());
        return right.panel.status.slice();
      }
      return exchange(request);
    };
    const error = await uploadProjectPair([left.job, right.job]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectUploadError);
    const results = (error as ProjectUploadError).results;
    expect(results.flatMap((r) => r.presets).every((p) => p.state === 'pending')).toBe(true);
    expect(results.map((r) => r.lastConfirmedMuted)).toEqual([true, false]);
    expect(String(error)).toContain('Could not verify mute');
    expect(left.panel.writes + right.panel.writes).toBe(0);
    expect(
      [left, right].flatMap((f) => f.panel.requests).some((r) => r[0] === 3 && r[1] === 0),
    ).toBe(false);
  });

  it('rejects a physical identity change after preparation before programming the first preset', async () => {
    const f = fixture('Original');
    const exchange = f.panel.exchange.bind(f.panel);
    f.panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 5 && request[1] === 0) {
        f.panel.eeprom.fill(0, 0x100, 0x120);
        f.panel.eeprom.set(new TextEncoder().encode('Replacement'), 0x100);
      }
      return reply;
    };
    const error = await uploadProjectPair([f.job]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectUploadError);
    expect((error as ProjectUploadError).results[0].presets.map((p) => p.state)).toEqual([
      'failed',
      'pending',
      'pending',
    ]);
    expect(String(error)).toContain('identity or firmware changed');
    expect(f.panel.writes).toBe(0);
    expect(f.panel.name).toBe('Simulator');
    expect(decodeStatus(f.panel.status).muted).toBe(true);
  });

  it('reports verified, failed and pending presets after a partial failure while the other role finishes independently', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const left = fixture('Left'),
      right = fixture('Right');
    left.panel.status[2] = 2;
    right.panel.status[2] = 3;
    left.job.presets.forEach((p, i) => (p.channels[0].gain = -i - 1));
    right.job.presets.forEach((p, i) => (p.channels[0].gain = -i - 8));
    const originals = [left.panel.memory.slice(), right.panel.memory.slice()];
    right.panel.failAtPage = presetBase(2);
    const error = await finish(uploadProjectPair([left.job, right.job])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectUploadError);
    const results = (error as ProjectUploadError).results;
    expect(results[0].presets.map((p) => p.state)).toEqual(['verified', 'verified', 'verified']);
    expect(results[1].presets.map((p) => p.state)).toEqual(['verified', 'failed', 'pending']);
    expect(results[0].activePresetRestored).toBe(true);
    expect(results[1].activePresetRestored).toBe(false);
    expect(results.every((r) => r.lastConfirmedMuted)).toBe(true);
    expect(String(error)).toContain('No automatic rollback');
    expectIir(left.panel, left.job.presets, originals[0]);
    expect(right.panel.memory.slice(presetBase(1), presetBase(2))).toEqual(
      compileSector(right.job.presets[0], originals[1].slice(presetBase(1), presetBase(2))),
    );
    expect(right.panel.memory.slice(presetBase(3), presetBase(3) + 4096)).toEqual(
      originals[1].slice(presetBase(3), presetBase(3) + 4096),
    );
    expect(left.panel.status[2]).toBe(2);
    expect([left, right].every((f) => decodeStatus(f.panel.status).muted)).toBe(true);
  });

  it('does not claim completion if all sectors verify but restoring the starting active preset fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture('Only');
    f.panel.status[2] = 2;
    const exchange = f.panel.exchange.bind(f.panel);
    f.panel.exchange = async (request) => {
      if (request[0] === 5 && request[1] === 0 && request[2] === 2 && f.panel.writes === 3)
        throw new Error('active preset restore failed');
      return exchange(request);
    };
    const error = await finish(uploadProjectPair([f.job])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProjectUploadError);
    const result = (error as ProjectUploadError).results[0];
    expect(result.presets.map((p) => p.state)).toEqual(['verified', 'verified', 'verified']);
    expect(result.activePresetRestored).toBe(false);
    expect(result.error).toContain('active preset restore failed');
    expect(result.lastConfirmedMuted).toBe(true);
    expect(f.panel.status[2]).toBe(3);
  });

  it('programs independently loaded FIR placements, preserves full-sector tails, and refreshes activation flags between presets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture('FIR'),
      [input, output] = f.job.presets;
    f.panel.status[2] = 2;
    f.panel.status[28] = 1;
    f.panel.status[30] = 0x91;
    f.panel.status[31] = 0x85;
    input.inputFir = {
      name: 'input.txt',
      enabled: true,
      taps: Array.from({ length: 4500 }, (_, i) => (i === 2 ? 1 : 0)),
    };
    output.firPlacement = 'output';
    output.channels[0].fir = {
      name: 'woofer.txt',
      enabled: false,
      taps: Array.from({ length: 1500 }, (_, i) => (i === 4 ? 0.5 : 0)),
    };
    output.channels[2].fir = {
      name: 'tweeter.txt',
      enabled: true,
      taps: Array.from({ length: 1500 }, (_, i) => (i === 8 ? 0.25 : 0)),
    };
    // Preserve arbitrary bytes outside the actual coefficient ranges.
    for (let i = 0x10000; i < 0x22000; i++) f.panel.memory[i] = i % 251;
    const before = f.panel.memory.slice(),
      expected = before.slice(),
      configuration = f.panel.deviceConfiguration.slice();
    expected.set(encodeFir(input.inputFir.taps, 4500), firLayout(1).base);
    expected.set(encodeFir(output.channels[0].fir.taps, 1500), firLayout(2).outputs[0]);
    expected.set(encodeFir(output.channels[2].fir.taps, 1500), firLayout(2).outputs[2]);
    const program = f.session.programInternal.bind(f.session);
    f.session.programInternal = async (...args) => {
      await program(...args);
      // An ignored input-enable flag changes after all plans were prepared.
      // The output plan must retain this latest bit instead of its stale copy.
      if (args[0] === 1) f.panel.status[29] |= 8;
    };
    await finish(uploadProjectPair([f.job]));
    expect(f.panel.memory.slice(0x10000, 0x22000)).toEqual(expected.slice(0x10000, 0x22000));
    expect(f.panel.status.slice(28, 31)).toEqual(Uint8Array.of(0x89, 0x5c, 1));
    expect(f.panel.status[31]).toBe(0x82);
    expect(f.panel.status[2]).toBe(2);
    expect(f.panel.deviceConfiguration).toEqual(configuration);
    expect(decodeStatus(f.panel.status).muted).toBe(true);
    expect(saveFirBackup).toHaveBeenCalledTimes(3);
    const names = vi.mocked(saveFirBackup).mock.calls.flatMap(([b]) => b.filenames);
    expect(names).toHaveLength(12);
    for (const [address, name] of [
      [0x200, 'input.txt'],
      [0x2a0, 'woofer.txt'],
      [0x2e0, 'tweeter.txt'],
    ] as const)
      expect(
        new TextDecoder().decode(f.panel.eeprom.slice(address, address + 32)).replace(/\0.*$/s, ''),
      ).toBe(name);
    for (const [b] of vi.mocked(saveFirBackup).mock.calls)
      b.sectors.forEach((s) =>
        expect(unhex(s.hex)).toEqual(before.slice(s.address, s.address + 4096)),
      );
  });

  it('rejects unsupported job and preset counts without device calls', async () => {
    const f = fixture('One');
    await expect(uploadProjectPair([])).rejects.toThrow('one or two');
    await expect(uploadProjectPair([f.job, f.job, f.job])).rejects.toThrow('one or two');
    await expect(
      uploadProjectPair([{ ...f.job, presets: f.job.presets.slice(0, 2) }]),
    ).rejects.toThrow('exactly three');
    expect(f.panel.requests).toHaveLength(0);
  });
});
