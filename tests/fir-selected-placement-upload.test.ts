import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject, type Fir } from '../src/domain/model';
import { projectSchema } from '../src/domain/files';
import { planFirActivation, planSelectedFirPlacement } from '../src/domain/fir-state';
import { presetResponse } from '../src/domain/dsp';
import { planNativeCloneFir } from '../src/hardware/clone-plan';
import { encodeFir, prepareFirInternal, uploadFir, type FirBackup } from '../src/hardware/fir';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { STATUS_FLAGS } from '../src/hardware/status-flags';
import { uploadProjectPair } from '../src/hardware/project-upload';
import { saveConfigurationBackup, saveFirBackup } from '../src/hardware/storage';

vi.mock('../src/hardware/storage', () => ({
  saveConfigurationBackup: vi.fn(async () => {}),
  saveFirBackup: vi.fn(async () => {}),
}));
beforeEach(() => vi.clearAllMocks());

afterEach(() => vi.useRealTimers());

const native = (capacity: number, amplitude: number): Fir => ({
  name: `Synthetic-${capacity}.txt`,
  enabled: true,
  taps: Array.from({ length: capacity }, (_, index) => (index === 0 ? amplitude : 0)),
  hfdState: { loaded: true, used: true, tapCount: capacity },
});
function bothUsed() {
  const project = newProject('Synthetic selected-placement FIR');
  const preset = project.presets[0];
  preset.firPlacement = 'output';
  preset.inputFir = native(4500, 0.5);
  preset.channels[0].fir = native(1500, 0.25);
  return projectSchema.parse(project).presets[0];
}
function setters(panel: SimulatedPanel) {
  return panel.requests.filter(
    (request) =>
      request[0] === 0x64 ||
      (request[0] === 5 && request[1] === 0) ||
      (request[0] === 3 && request[1] === 0) ||
      (request[0] === 0x66 && request[1] === 1),
  );
}
async function finish<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  const settled = operation.then(
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
  if (!done) throw new Error('Synthetic FIR operation did not settle');
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

describe('selected-placement FIR programming independent of graph Used', () => {
  it('accepts the same valid native two-Used state as Clone without changing either graph bank', () => {
    const preset = bothUsed(),
      before = structuredClone(preset);
    const clone = planNativeCloneFir(preset, 0xff);
    expect(clone.warnings).toEqual([
      'Inactive input graph FIR is not transferred; only the selected placement is programmed.',
    ]);
    const normal = planFirActivation(preset, 0xff);
    expect(normal.placement).toBe(clone.placement);
    expect(normal.flags).toBe(clone.flags);
    expect(normal.banks.map((bank) => bank.channel)).toEqual([1, 2, 3]);
    expect(normal.warnings).toEqual(clone.warnings);
    expect(presetResponse(preset, 0, 1000)[0]).toBeCloseTo(0.125, 12);
    expect(preset).toEqual(before);
  });

  it('uses the selected input regardless of Used and warns about each effective output without normalizing graph state', () => {
    const preset = bothUsed();
    preset.firPlacement = 'input';
    preset.inputFir.hfdState!.used = false;
    preset.channels[2].fir = native(1500, 0.75);
    const before = structuredClone(preset),
      plan = planSelectedFirPlacement(preset);
    expect(plan.banks.map((bank) => bank.channel)).toEqual([0]);
    expect(plan.banks[0].loaded).toBe(true);
    expect(plan.warnings).toEqual([
      'Inactive output 1 graph FIR is not transferred; only the selected placement is programmed.',
      'Inactive output 3 graph FIR is not transferred; only the selected placement is programmed.',
    ]);
    expect(planFirActivation(preset, 5).flags).toBe(0x8d);
    expect(planFirActivation(preset, 5).flags).toBe(planNativeCloneFir(preset, 5).flags);
    expect(preset).toEqual(before);
  });

  it('does not warn about a retained bank that is bypassed or not Used, while preserving its original data', () => {
    const preset = bothUsed();
    for (const patch of [
      { enabled: false },
      { hfdState: { loaded: true, used: false, tapCount: 4500 } },
    ]) {
      Object.assign(preset.inputFir, patch);
      const before = structuredClone(preset);
      expect(planSelectedFirPlacement(preset).warnings).toEqual([]);
      expect(preset).toEqual(before);
    }
  });

  it.each([0, 1, 10, 1499])(
    'keeps the ordinary full-capacity gate for a selected loaded %s-sample output before any query',
    async (count) => {
      const preset = bothUsed(),
        panel = new SimulatedPanel(),
        session = new PanelSession(panel, async () => {});
      preset.channels[0].fir = native(count, 0.25);
      const before = structuredClone(preset);
      await expect(prepareFirInternal(session, 1, preset, async () => {})).rejects.toThrow(
        /1500 original taps/,
      );
      expect(panel.requests).toEqual([]);
      expect(preset).toEqual(before);
    },
  );

  it('does not transfer an inactive short native cache or mistake the Clone tiny-cache exception for ordinary upload policy', () => {
    const preset = bothUsed();
    preset.inputFir = native(1, 0.5);
    expect(planFirActivation(preset, 0xff).banks.map((bank) => bank.channel)).toEqual([1, 2, 3]);
    preset.firPlacement = 'input';
    expect(planNativeCloneFir(preset, 0xff).anyTransfer).toBe(false);
    expect(() => planFirActivation(preset, 0xff)).toThrow(/4500 original taps/);
  });

  it.each(['malformed-inactive', 'overflow', 'zero'] as const)(
    'keeps %s validation before any device query',
    async (kind) => {
      const preset = bothUsed(),
        panel = new SimulatedPanel(),
        session = new PanelSession(panel, async () => {});
      if (kind === 'malformed-inactive') preset.inputFir.taps[0] = NaN;
      if (kind === 'overflow') preset.channels[0].fir.taps[0] = 128;
      if (kind === 'zero') preset.channels[0].fir.taps.fill(0);
      await expect(prepareFirInternal(session, 1, preset, async () => {})).rejects.toThrow();
      expect(panel.requests).toEqual([]);
    },
  );

  it.each(['input', 'output'] as const)(
    'uploads only selected %s data/names with complete backups first and preserves the two-Used graph document',
    async (placement) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const preset = bothUsed(),
        panel = new SimulatedPanel(),
        session = new PanelSession(panel, async () => {});
      preset.firPlacement = placement;
      panel.status[28] = 0xff;
      panel.status[31] = 7;
      panel.memory.set(
        Uint8Array.from({ length: 0x6000 }, (_, index) => index % 251),
        0x10000,
      );
      panel.eeprom.set(
        Uint8Array.from({ length: 128 }, (_, index) => index + 1),
        0x200,
      );
      const before = structuredClone(preset),
        memory = panel.memory.slice(0x10000, 0x16000),
        names = panel.eeprom.slice(0x200, 0x280),
        saved: FirBackup[] = [];
      const result = await finish(
        uploadFir(
          session,
          1,
          preset,
          () => {},
          async (backup) => {
            expect(setters(panel)).toEqual([]);
            expect(backup.sectors).toHaveLength(6);
            expect(backup.filenames).toHaveLength(4);
            saved.push(backup);
          },
        ),
      );
      expect(result).toBe(saved[0]);
      const selected = placement === 'input' ? preset.inputFir : preset.channels[0].fir;
      const expected = memory.slice();
      expected.set(encodeFir(selected.taps, placement === 'input' ? 4500 : 1500), 0);
      expect(panel.memory.slice(0x10000, 0x16000)).toEqual(expected);
      const selectedName = placement === 'input' ? 0 : 1;
      for (let index = 0; index < 4; index++) {
        const actual = panel.eeprom.slice(0x200 + index * 32, 0x220 + index * 32);
        if (index === selectedName)
          expect(new TextDecoder().decode(actual).replace(/\0.*$/s, '')).toBe(selected.name);
        else expect(actual).toEqual(names.slice(index * 32, (index + 1) * 32));
      }
      expect(panel.status[28]).toBe(placement === 'input' ? 0x8f : 0x19);
      expect(panel.status[31] & 1).toBe(placement === 'input' ? 0 : 1);
      expect(panel.status[31] & 6).toBe(6);
      expect(panel.status[6] & 128).toBe(128);
      expect(preset).toEqual(before);
      expect(presetResponse(preset, 0, 1000)[0]).toBeCloseTo(0.125, 12);
    },
  );

  it.each(['storage', 'mode', 'protection'] as const)(
    'still refuses %s failure with zero setters for a valid two-Used design',
    async (fault) => {
      const preset = bothUsed(),
        panel = new SimulatedPanel(),
        session = new PanelSession(panel, async () => {});
      if (fault === 'mode') panel.status[10] = 32;
      if (fault === 'protection') panel.status[51] = STATUS_FLAGS.passwordProtected;
      await expect(
        uploadFir(
          session,
          1,
          preset,
          () => {},
          async () => {
            if (fault === 'storage') throw new Error('Synthetic durable backup failure');
          },
        ),
      ).rejects.toThrow();
      expect(setters(panel)).toEqual([]);
      expect(panel.writes).toBe(0);
    },
  );

  it('reports each all-project preset advisory before any setter and keeps every original design while programming only selected FIRs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const project = newProject('Synthetic selected-placement project'),
      panel = new SimulatedPanel('SIM-SELECTED-PROJECT'),
      iirBackups: unknown[] = [],
      session = new PanelSession(panel, async (backup) => {
        iirBackups.push(backup);
      });
    project.presets[0] = bothUsed();
    project.presets[1] = bothUsed();
    project.presets[1].firPlacement = 'input';
    const before = structuredClone(project),
      messages: string[] = [],
      exchange = panel.exchange.bind(panel);
    let firstSetter = true;
    panel.exchange = async (request) => {
      if (
        firstSetter &&
        (request[0] === 0x64 || ((request[0] === 5 || request[0] === 3) && request[1] === 0))
      ) {
        firstSetter = false;
        expect(iirBackups).toHaveLength(3);
        expect(saveFirBackup).toHaveBeenCalledTimes(3);
        expect(saveConfigurationBackup).toHaveBeenCalledOnce();
      }
      return exchange(request);
    };
    await finish(
      uploadProjectPair([
        {
          session,
          presets: project.presets,
          name: project.name,
          label: 'Synthetic Left',
          progress: (_percent, message) => {
            if (message.includes('graph FIR is not transferred')) {
              expect(setters(panel)).toEqual([]);
              messages.push(message);
            }
          },
        },
      ]),
    );
    expect(messages).toEqual([
      'Synthetic Left · Preset 1/3 · Inactive input graph FIR is not transferred; only the selected placement is programmed.',
      'Synthetic Left · Preset 2/3 · Inactive output 1 graph FIR is not transferred; only the selected placement is programmed.',
    ]);
    expect(firstSetter).toBe(false);
    expect(panel.memory.slice(0x10000, 0x10000 + 6000)).toEqual(
      encodeFir(project.presets[0].channels[0].fir.taps, 1500),
    );
    expect(panel.memory.slice(0x16000, 0x16000 + 18000)).toEqual(
      encodeFir(project.presets[1].inputFir.taps, 4500),
    );
    expect(project).toEqual(before);
    expect(panel.status[6] & 128).toBe(128);
  });
});
