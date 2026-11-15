import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../src/domain/model';
import { decodeEq, decodeStatus, encodeEq, hex, presetBase } from '../src/hardware/codec';
import {
  EqBankUploadError,
  readEqBank,
  uploadEqBankPair,
  type EqBankRecord,
  type EqBankUploadJob,
} from '../src/hardware/eq-bank';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { saveConfigurationBackup } from '../src/hardware/storage';

vi.mock('../src/hardware/storage', () => ({
  saveConfigurationBackup: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.mocked(saveConfigurationBackup).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

const eqBase = (preset: number) => presetBase(preset) + 0x3000;
const mutates = (r: Uint8Array) =>
  r[0] === 0x64 || ((r[0] === 5 || r[0] === 3) && r[1] === 0) || (r[0] === 0x66 && r[1] === 1);

function fixture(serial: string) {
  const panel = new SimulatedPanel(serial),
    backups: Backup[] = [],
    session = new PanelSession(panel, async (b) => {
      backups.push(structuredClone(b));
    }),
    bank = newProject(serial).presets.map((p, i) => ({ bands: p.inputEq, enabled: i !== 1 })),
    job: EqBankUploadJob = { session, bank, label: serial };
  for (const preset of [1, 2, 3]) {
    panel.memory.set(encodeEq(bank[preset - 1].bands), eqBase(preset));
    panel.memory.fill(0xa0 + preset, eqBase(preset) + 256, eqBase(preset) + 4096);
  }
  return { panel, backups, session, job };
}

/** Fake only simulated flash waits, yielding to real WebCrypto between turns. */
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
  if (!done) throw new Error('Simulator EQ bank operation did not settle');
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function distinctBank(bank: EqBankRecord[], offset = 0) {
  bank.forEach((r, p) => {
    r.enabled = (p + offset) % 2 === 0;
    r.bands.forEach((f, i) => {
      f.kind = i === 0 ? 'lowshelf2' : i === 8 ? 'highshelf2' : 'peak';
      f.enabled = i % 2 === 0;
      f.gain = -(p + offset + i / 10 + 1);
    });
  });
}

describe('reading all three input EQ sets', () => {
  it('persists exact backups and returns independent records without changing any amplifier state or caller design', async () => {
    const f = fixture('Read');
    distinctBank(f.job.bank);
    f.job.bank.forEach((r, p) => f.panel.memory.set(encodeEq(r.bands), eqBase(p + 1)));
    f.panel.status[2] = 3;
    f.panel.status[6] = 5;
    f.panel.status.set([0xa5, 0xb6, 0x47], 12);
    f.panel.status[51] = 2; // Reading must not require a password unlock.
    const memory = f.panel.memory.slice(),
      eeprom = f.panel.eeprom.slice(),
      status = f.panel.status.slice(),
      configuration = f.panel.deviceConfiguration.slice(),
      source = structuredClone(f.job.bank),
      exclusive = vi.spyOn(f.session, 'exclusive');
    const bank = await readEqBank(f.session);
    expect(bank.map((r) => r.enabled)).toEqual([false, true, false]);
    expect(exclusive).toHaveBeenCalledTimes(1);
    expect(bank).toHaveLength(3);
    bank.forEach((r, p) => {
      expect(encodeEq(r.bands)).toEqual(memory.slice(eqBase(p + 1), eqBase(p + 1) + 256));
      expect(r.bands).toHaveLength(9);
    });
    expect(new Set(bank.flatMap((r) => r.bands.map((b) => b.id))).size).toBe(27);
    expect(f.backups.map((b) => b.address)).toEqual([0x25000, 0x26000, 0x27000]);
    f.backups.forEach((b) => {
      expect(b.sector_hex).toBe(hex(memory.slice(b.address, b.address + 4096)));
      expect(b.status_hex).toBe(hex(status));
    });
    bank[0].bands[0].gain = -30;
    bank[0].enabled = true;
    expect(bank[1].bands[0].gain).toBe(source[1].bands[0].gain);
    expect(f.job.bank).toEqual(source);
    expect(f.panel.memory).toEqual(memory);
    expect(f.panel.eeprom).toEqual(eeprom);
    expect(f.panel.status).toEqual(status);
    expect(f.panel.deviceConfiguration).toEqual(configuration);
    expect(f.panel.name).toBe('Simulator');
    expect(f.panel.eqReloads).toBe(0);
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
    expect(saveConfigurationBackup).not.toHaveBeenCalled();
    expect(f.panel.maxConcurrent).toBe(1);
  });

  it('uses fresh identity and final enable flags instead of cached session state', async () => {
    const f = fixture('Actual');
    await f.session.identify();
    f.session.identity!.serial = 'Stale cached serial';
    const save = f.session.saveBackup;
    Object.defineProperty(f.session, 'saveBackup', {
      value: async (b: Backup) => {
        await save(b);
        if (b.preset === 3) f.panel.status.set([16, 0, 16], 12);
      },
    });
    const bank = await readEqBank(f.session);
    expect(bank.map((r) => r.enabled)).toEqual([true, false, true]);
    expect(f.session.identity?.serial).toBe('Actual');
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
  });

  it('holds one reservation across every sector backup and final status read', async () => {
    const f = fixture('Read');
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (reached = resolve)),
      save = f.session.saveBackup;
    Object.defineProperty(f.session, 'saveBackup', {
      value: async (b: Backup) => {
        await save(b);
        if (b.preset === 3) {
          reached();
          await held;
        }
      },
    });
    const operation = readEqBank(f.session);
    await ready;
    let entered = false;
    const queued = f.session.exclusive(async () => {
      entered = true;
    });
    await yieldEventLoop();
    expect(f.session.busy).toBe(true);
    expect(entered).toBe(false);
    release();
    expect(await operation).toHaveLength(3);
    await queued;
    expect(entered).toBe(true);
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
  });

  it('keeps an exact recovery backup and performs no writes when a late EQ CRC is invalid', async () => {
    const f = fixture('Read');
    f.panel.memory[eqBase(3)] ^= 1;
    const before = f.panel.memory.slice();
    await expect(readEqBank(f.session)).rejects.toThrow('CRC mismatch');
    expect(f.backups).toHaveLength(3);
    expect(f.backups[2].sector_hex).toBe(hex(before.slice(eqBase(3), eqBase(3) + 4096)));
    expect(f.panel.memory).toEqual(before);
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
  });

  it('rejects a late read-backup persistence failure without changing amplifier state', async () => {
    const f = fixture('Read'),
      status = f.panel.status.slice(),
      memory = f.panel.memory.slice(),
      save = f.session.saveBackup;
    Object.defineProperty(f.session, 'saveBackup', {
      value: async (b: Backup) => {
        if (b.preset === 3) throw new Error('storage full');
        await save(b);
      },
    });
    await expect(readEqBank(f.session)).rejects.toThrow('storage full');
    expect(f.panel.memory).toEqual(memory);
    expect(f.panel.status).toEqual(status);
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
    expect(f.session.busy).toBe(false);
  });

  it('rejects an identity change during the bank read without mutating the device', async () => {
    const f = fixture('Original'),
      save = f.session.saveBackup;
    Object.defineProperty(f.session, 'saveBackup', {
      value: async (b: Backup) => {
        await save(b);
        if (b.preset === 2) {
          f.panel.eeprom.fill(0, 0x100, 0x120);
          f.panel.eeprom.set(new TextEncoder().encode('Replacement'), 0x100);
        }
      },
    });
    await expect(readEqBank(f.session)).rejects.toThrow('identity or firmware changed');
    expect(f.panel.requests.filter(mutates)).toHaveLength(0);
  });
});

describe('uploading all three input EQ sets', () => {
  it('prepares both complete banks before any mutation and retains distinct contents, sector tails, active presets and unrelated flags', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const left = fixture('Left'),
      right = fixture('Right'),
      progress: { n: number; text: string }[] = [];
    distinctBank(left.job.bank);
    distinctBank(right.job.bank, 4);
    left.panel.status[2] = 2;
    right.panel.status[2] = 3;
    left.panel.status[6] = 5;
    right.panel.status[6] = 2;
    left.panel.status.set([0xa5, 0xd6, 0x77], 12);
    right.panel.status.set([0x36, 0x57, 0xa2], 12);
    left.panel.status.set([0x88, 0x31, 0x52, 5], 28);
    right.panel.status.set([0x14, 0x42, 0x89, 2], 28);
    left.job.progress = (n, text) => progress.push({ n, text });
    const originals = [left, right].map((f) => ({
        memory: f.panel.memory.slice(),
        status: f.panel.status.slice(),
        eeprom: f.panel.eeprom.slice(),
        configuration: f.panel.deviceConfiguration.slice(),
        bank: structuredClone(f.job.bank),
      })),
      exclusive = [vi.spyOn(left.session, 'exclusive'), vi.spyOn(right.session, 'exclusive')];
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
          expect(left.session.busy && right.session.busy).toBe(true);
        }
        if (request[0] === 0x64 && request[1] === 4)
          expect(decodeStatus(other.panel.status).muted).toBe(true);
        return exchange(request);
      };
    }
    await finish(uploadEqBankPair([left.job, right.job]));
    for (const [i, f] of [left, right].entries()) {
      const original = originals[i],
        expected = original.memory.slice(),
        expectedStatus = original.status.slice();
      original.bank.forEach((r, p) => {
        expected.set(encodeEq(r.bands), eqBase(p + 1));
        expectedStatus[12 + p] = (expectedStatus[12 + p] & 0xef) | (r.enabled ? 16 : 0);
        expect(
          encodeEq(decodeEq(f.panel.memory.slice(eqBase(p + 1), eqBase(p + 1) + 256))),
        ).toEqual(encodeEq(r.bands));
      });
      expectedStatus[6] |= 128;
      expect(f.panel.memory).toEqual(expected);
      expect(f.panel.status).toEqual(expectedStatus);
      expect(f.panel.eeprom).toEqual(original.eeprom);
      expect(f.panel.deviceConfiguration).toEqual(original.configuration);
      expect(f.job.bank).toEqual(original.bank);
      expect(f.panel.name).toBe('Simulator');
      expect(f.panel.writes).toBe(3);
      expect(f.panel.eqReloads).toBe(3);
      expect(f.panel.maxConcurrent).toBe(1);
      expect(exclusive[i]).toHaveBeenCalledTimes(1);
      expect(
        f.panel.requests
          .filter((r) => r[0] === 5 && r[1] === 0)
          .every((r) => r[2] === original.status[2]),
      ).toBe(true);
      f.backups.forEach((b) =>
        expect(b.sector_hex).toBe(hex(original.memory.slice(b.address, b.address + 4096))),
      );
    }
    expect(
      progress.filter((p) => /EQ preset [123]\/3 · verified · muted$/.test(p.text)),
    ).toHaveLength(3);
    expect(progress.at(-1)?.n).toBe(100);
    expect(progress.every((p, i) => i === 0 || p.n >= progress[i - 1].n)).toBe(true);
  });

  it.each(['unsupported band', 'band count', 'nonfinite disabled metadata', 'enable flag'])(
    'rejects a late %s error before any write on either amp',
    async (failure) => {
      const left = fixture('Left'),
        right = fixture('Right'),
        record = right.job.bank[2];
      if (failure === 'unsupported band') record.bands[8].kind = 'raw';
      if (failure === 'band count') record.bands.pop();
      if (failure === 'nonfinite disabled metadata') record.bands[8].q = Number.NaN;
      if (failure === 'enable flag') record.enabled = 1 as unknown as boolean;
      const error = await uploadEqBankPair([left.job, right.job]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EqBankUploadError);
      expect((error as EqBankUploadError).results[1].presets.map((p) => p.state)).toEqual([
        'pending',
        'pending',
        'failed',
      ]);
      expect((error as EqBankUploadError).results[1].presets[2].phase).toBe('preflight');
      expect(String(error)).toContain('Nothing programmed');
      expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
    },
  );

  it.each(['shared configuration', 'third sector'])(
    'performs no writes if the %s backup cannot be persisted',
    async (failure) => {
      const left = fixture('Left'),
        right = fixture('Right');
      if (failure === 'shared configuration')
        vi.mocked(saveConfigurationBackup).mockImplementation(async (b) => {
          if (b.serial === 'Right') throw new Error('storage full');
        });
      else
        Object.defineProperty(right.session, 'saveBackup', {
          value: async (b: Backup) => {
            if (b.preset === 3) throw new Error('storage full');
          },
        });
      await expect(uploadEqBankPair([left.job, right.job])).rejects.toThrow('storage full');
      expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
    },
  );

  it('keeps both reservations until every preparation settles after a peer validation failure', async () => {
    const left = fixture('Left'),
      right = fixture('Right');
    left.job.bank[2].bands.pop();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (reached = resolve)),
      save = right.session.saveBackup;
    Object.defineProperty(right.session, 'saveBackup', {
      value: async (b: Backup) => {
        await save(b);
        if (b.preset === 3) {
          reached();
          await held;
        }
      },
    });
    const operation = uploadEqBankPair([left.job, right.job]).catch((e: unknown) => e);
    await ready;
    const entered: string[] = [],
      queued = [left, right].map((f) =>
        f.session.exclusive(async () => void entered.push(f.job.label!)),
      );
    await yieldEventLoop();
    expect(left.session.busy && right.session.busy).toBe(true);
    expect(entered).toEqual([]);
    release();
    expect(await operation).toBeInstanceOf(EqBankUploadError);
    await Promise.all(queued);
    expect(entered.sort()).toEqual(['Left', 'Right']);
    expect([...left.panel.requests, ...right.panel.requests].filter(mutates)).toHaveLength(0);
  });

  it('rejects duplicate objects or physical serials before programming', async () => {
    const a = fixture('Same'),
      b = fixture('Same');
    await expect(uploadEqBankPair([a.job, a.job])).rejects.toThrow('distinct amplifier');
    expect(a.panel.requests).toHaveLength(0);
    await expect(uploadEqBankPair([a.job, b.job])).rejects.toThrow('same physical amplifier');
    expect([...a.panel.requests, ...b.panel.requests].filter(mutates)).toHaveLength(0);
  });

  it('requires a verified mute on every panel before programming either bank', async () => {
    const left = fixture('Left'),
      right = fixture('Right');
    left.panel.status[6] = right.panel.status[6] = 0;
    const exchange = right.panel.exchange.bind(right.panel);
    right.panel.exchange = async (request) => {
      if (request[0] === 5 && request[1] === 0) return right.panel.status.slice();
      return exchange(request);
    };
    const error = await uploadEqBankPair([left.job, right.job]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EqBankUploadError);
    expect(String(error)).toContain('Could not verify mute');
    expect((error as EqBankUploadError).results.map((r) => r.lastConfirmedMuted)).toEqual([
      true,
      false,
    ]);
    expect(left.panel.writes + right.panel.writes).toBe(0);
    expect(left.panel.eqReloads + right.panel.eqReloads).toBe(0);
  });

  it('reports a partial ledger, retains mute, and lets the unaffected amp finish all three records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const left = fixture('Left'),
      right = fixture('Right');
    distinctBank(left.job.bank);
    distinctBank(right.job.bank, 5);
    right.panel.failAtPage = eqBase(2);
    const originalRight = right.panel.memory.slice();
    const error = await finish(uploadEqBankPair([left.job, right.job])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EqBankUploadError);
    const results = (error as EqBankUploadError).results;
    expect(results[0].presets.map((p) => p.state)).toEqual(['verified', 'verified', 'verified']);
    expect(results[1].presets.map((p) => p.state)).toEqual(['verified', 'failed', 'pending']);
    expect(results[0].activePresetRestored).toBe(true);
    expect(results[1].activePresetRestored).toBe(false);
    expect(results.every((r) => r.lastConfirmedMuted)).toBe(true);
    expect(String(error)).toContain('No automatic rollback');
    expect(right.panel.memory.slice(eqBase(1), eqBase(1) + 256)).toEqual(
      encodeEq(right.job.bank[0].bands),
    );
    expect(right.panel.memory.slice(eqBase(3), eqBase(3) + 4096)).toEqual(
      originalRight.slice(eqBase(3), eqBase(3) + 4096),
    );
    expect(left.panel.eqReloads).toBe(3);
    expect(right.panel.eqReloads).toBe(1);
  });

  it('freezes all caller records before the first backup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture('Frozen'),
      expected = structuredClone(f.job.bank),
      save = f.session.saveBackup;
    Object.defineProperty(f.session, 'saveBackup', {
      value: async (b: Backup) => {
        await save(b);
        f.job.bank[2].bands[0].gain = -20;
        f.job.bank[2].enabled = !expected[2].enabled;
      },
    });
    await finish(uploadEqBankPair([f.job]));
    expect(f.panel.memory.slice(eqBase(3), eqBase(3) + 256)).toEqual(encodeEq(expected[2].bands));
    expect(!!(f.panel.status[14] & 16)).toBe(expected[2].enabled);
  });

  it.each([false, true])(
    'preserves mixed live activation flags for Save-to-all, including changed-since-backup=%s',
    async (changed) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const f = fixture('Save all');
      distinctBank(f.job.bank);
      f.job.preserveActivation = true;
      f.job.bank.forEach((r) => (r.enabled = true));
      f.panel.status.set([0xa5, 0xd6, 0x67], 12); // off, on, off
      const program = f.session.programEqInternal.bind(f.session);
      f.session.programEqInternal = async (...args) => {
        await program(...args);
        if (changed && args[0] === 1) {
          f.panel.status[13] &= 0xef;
          f.panel.status[14] |= 16;
        }
      };
      await finish(uploadEqBankPair([f.job]));
      expect(Array.from(f.panel.status.slice(12, 15), (n) => !!(n & 16))).toEqual(
        changed ? [false, false, true] : [false, true, false],
      );
      expect(Array.from(f.panel.status.slice(12, 15), (n) => n & 0xef)).toEqual([0xa5, 0xc6, 0x67]);
      f.job.bank.forEach((r, p) =>
        expect(f.panel.memory.slice(eqBase(p + 1), eqBase(p + 1) + 256)).toEqual(encodeEq(r.bands)),
      );
    },
  );

  it.each(['preparation', 'final backup', 'programming'])(
    'rejects a physical identity change during %s before the next sector write',
    async (phase) => {
      const f = fixture('Original'),
        replace = () => {
          f.panel.eeprom.fill(0, 0x100, 0x120);
          f.panel.eeprom.set(new TextEncoder().encode('Replacement'), 0x100);
        };
      if (phase !== 'programming') {
        const save = f.session.saveBackup;
        Object.defineProperty(f.session, 'saveBackup', {
          value: async (b: Backup) => {
            await save(b);
            if (b.preset === (phase === 'preparation' ? 1 : 3)) replace();
          },
        });
      } else {
        const exchange = f.panel.exchange.bind(f.panel);
        f.panel.exchange = async (request) => {
          const reply = await exchange(request);
          if (request[0] === 5 && request[1] === 0) replace();
          return reply;
        };
      }
      const error = await uploadEqBankPair([f.job]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EqBankUploadError);
      expect(String(error)).toContain('identity or firmware changed');
      expect(f.panel.writes).toBe(0);
      expect(f.panel.eqReloads).toBe(0);
      if (phase !== 'programming') expect(f.panel.requests.filter(mutates)).toHaveLength(0);
      else expect(decodeStatus(f.panel.status).muted).toBe(true);
    },
  );

  it('distinguishes complete sector verification from failure to restore the starting preset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture('Restore');
    f.panel.status[2] = 2;
    let controls = 0;
    const exchange = f.panel.exchange.bind(f.panel);
    f.panel.exchange = async (request) => {
      if (request[0] === 5 && request[1] === 0 && ++controls === 5)
        throw new Error('active preset restore failed');
      return exchange(request);
    };
    const error = await finish(uploadEqBankPair([f.job])).catch((e: unknown) => e);
    const result = (error as EqBankUploadError).results[0];
    expect(result.presets.map((p) => p.state)).toEqual(['verified', 'verified', 'verified']);
    expect(result.activePresetRestored).toBe(false);
    expect(result.lastConfirmedMuted).toBe(true);
    expect(result.error).toContain('active preset restore failed');
  });

  it('rejects invalid active preset, unsupported hardware and malformed bank sizes without writing', async () => {
    const invalid = fixture('Invalid'),
      unsupported = fixture('Unsupported');
    invalid.panel.status[2] = 0;
    unsupported.panel.configuration[1] = 18;
    await expect(readEqBank(invalid.session)).rejects.toThrow('Invalid panel status');
    await expect(uploadEqBankPair([invalid.job])).rejects.toThrow('Invalid panel status');
    await expect(readEqBank(unsupported.session)).rejects.toThrow('FA503');
    await expect(uploadEqBankPair([unsupported.job])).rejects.toThrow('FA503');
    await expect(uploadEqBankPair([])).rejects.toThrow('one or two');
    await expect(uploadEqBankPair([invalid.job, invalid.job, invalid.job])).rejects.toThrow(
      'one or two',
    );
    await expect(
      uploadEqBankPair([{ ...invalid.job, bank: invalid.job.bank.slice(0, 2) }]),
    ).rejects.toThrow('exactly three');
    expect([...invalid.panel.requests, ...unsupported.panel.requests].filter(mutates)).toHaveLength(
      0,
    );
  });
});
