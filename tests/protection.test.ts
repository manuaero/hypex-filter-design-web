import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../src/domain/model';
import { control, decodeStatus, hex, type Controls } from '../src/hardware/codec';
import { decodeLimiter, encodeLimiter } from '../src/hardware/device-settings';
import { uploadEqBankPair } from '../src/hardware/eq-bank';
import { prepareFirInternal, uploadFir, writeFirNameInternal } from '../src/hardware/fir';
import { uploadProjectPair } from '../src/hardware/project-upload';
import {
  OEM_ITEMS,
  assertOperationAllowed,
  decodeProtection,
  requiredControlOperations,
  type ProtectionOperation,
} from '../src/hardware/protection';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { saveConfigurationBackup } from '../src/hardware/storage';

vi.mock('../src/hardware/storage', () => ({
  saveConfigurationBackup: vi.fn(async () => {}),
  saveFirBackup: vi.fn(async () => {}),
}));
beforeEach(() => vi.mocked(saveConfigurationBackup).mockClear());
const bit = (id: string) => OEM_ITEMS.find((item) => item.id === id)!.mask;
function fixture(mask = 0, moduleType = 0, flags = 2, serial = 'TEST') {
  const panel = new SimulatedPanel(serial),
    session = new PanelSession(panel, async () => {});
  panel.status[51] = flags;
  panel.status[24] = mask & 255;
  panel.status[25] = mask >> 8;
  panel.configuration[4] = 0x10;
  panel.deviceConfiguration[11] = moduleType;
  return { panel, session };
}
const writes = (panel: SimulatedPanel) =>
  panel.requests.filter(
    (r) =>
      r[0] === 0x64 || ([5, 3, 8].includes(r[0]) && r[1] === 0) || (r[0] === 0x66 && r[1] === 1),
  );
const channels = Array.from({ length: 3 }, () => ({
  watts: 25,
  ohms: 4,
  attackMs: 10,
  releaseMs: 250,
}));

describe('native OEM permission inventory versus actual operation gates', () => {
  it('retains all14 bit ordinals, unknown high bits and native no-password mask fallback', () => {
    expect(OEM_ITEMS).toHaveLength(14);
    expect(OEM_ITEMS.map((item) => item.mask)).toEqual(
      Array.from({ length: 14 }, (_, i) => 1 << i),
    );
    const { panel } = fixture(0xc008, 1),
      status = decodeStatus(panel.status);
    expect(decodeProtection(status, 1)).toMatchObject({
      rawMask: 0xc008,
      effectiveMask: 0xc008,
      locked: true,
      isOemConfigured: true,
    });
    panel.status[51] = 0;
    expect(decodeProtection(decodeStatus(panel.status), 0)).toMatchObject({
      rawMask: 0xc008,
      effectiveMask: 0xffff,
      locked: false,
    });
  });

  it('does not add first-three bits on reads, while native runtime operations remain accessible', () => {
    const { panel } = fixture(),
      report = decodeProtection(decodeStatus(panel.status), 0);
    expect(report.items.slice(0, 3).every((item) => !item.maskEnabled)).toBe(true);
    for (const id of ['inputSource', 'volumeMute', 'preset'] as const)
      expect(report.operations[id].allowed).toBe(true);
    expect(report.rawMask).toBe(0);
    expect(report.effectiveMask).toBe(0);
  });

  it('implements protected/matched truth independently of unrelated status flags', () => {
    for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const { panel } = fixture(0, 0, flags),
        report = decodeProtection(decodeStatus(panel.status), 0);
      expect(report.passwordProtected).toBe(!!(flags & 2));
      expect(report.passwordMatched).toBe(!!(flags & 4));
      expect(report.locked).toBe(!!(flags & 2) && !(flags & 4));
      expect(report.operations.manufacturing.allowed).toBe(!report.locked);
    }
  });

  it('honors uploadbit7 independently of OEM module classification', () => {
    for (const moduleType of [undefined, 0, 1, 2, 255]) {
      const { panel } = fixture(bit('uploadFilters'));
      expect(
        decodeProtection(decodeStatus(panel.status), moduleType).operations.uploadFilters.allowed,
      ).toBe(true);
      panel.status[24] = 0;
      expect(() =>
        assertOperationAllowed(decodeStatus(panel.status), 'uploadFilters', moduleType),
      ).toThrow('permission denied');
    }
  });

  it('requires configured OEM module1 for locked settings, firmware and EQ entries', () => {
    for (const moduleType of [undefined, 0, 1, 2]) {
      const { panel } = fixture(0xffff),
        report = decodeProtection(decodeStatus(panel.status), moduleType);
      for (const operation of ['deviceSettings', 'equalizer', 'updateFirmware'] as const)
        expect(report.operations[operation].allowed).toBe(moduleType === 1);
      expect(report.items.every((item) => item.maskEnabled)).toBe(true);
    }
  });

  it.each(['softclipLimiter', 'bridge', 'masterSlave', 'dacFilter', 'digitalLeftRight'] as const)(
    'intersects native settings entry and %s child permission',
    (operation) => {
      for (const mask of [
        0,
        bit('deviceSettings'),
        bit(operation),
        bit('deviceSettings') | bit(operation),
      ]) {
        const { panel } = fixture(mask, 1),
          permission = decodeProtection(decodeStatus(panel.status), 1).operations[operation];
        expect(permission.allowed).toBe(mask === (bit('deviceSettings') | bit(operation)));
        expect(permission.requiredItems).toEqual(['deviceSettings', operation]);
      }
    },
  );

  it('keeps unmapped and manufacturing operations refused even with every mask bit enabled', () => {
    const { panel } = fixture(0xffff, 1);
    for (const operation of ['unknown', 'manufacturing', 'motionFeedback', 'routing'] as const)
      expect(() => assertOperationAllowed(decodeStatus(panel.status), operation, 1)).toThrow(
        'requires an unlocked panel',
      );
    for (const patch of [
      { sourceLock: false },
      { volumeLock: false },
      { adcOutput: false },
    ] as Controls[])
      expect(() => control(decodeStatus(panel.status), patch, 1)).toThrow('mapping');
  });

  it('maps all supplied fields, including false, and sound-quality/FIR mode to the proven DAC parent', () => {
    expect(
      requiredControlOperations({ mute: true, softClip: false, soundQuality: 3, firMode: 0 }),
    ).toEqual(['volumeMute', 'softclipLimiter', 'dacFilter']);
    const { panel } = fixture(bit('deviceSettings') | bit('softclipLimiter'), 1);
    expect(() =>
      control(decodeStatus(panel.status), { mute: true, softClip: false, dacFilter: 0 }, 1),
    ).toThrow('dacFilter');
  });
});

describe('fresh session permissions and protected programming', () => {
  it('preserves stored mask/protection and clears OEM triggers through runtime changes on a locked commercial panel', async () => {
    const { panel, session } = fixture(0xc000, 0);
    panel.status[23] = 255;
    const status = await session.setControls({
      mute: true,
      volume: -22,
      forceInput: 0,
      preset: 2,
      channelMutes: [true, false, true],
    });
    expect(status.locked).toBe(true);
    expect(status.raw[24]).toBe(0);
    expect(status.raw[25]).toBe(0xc0);
    expect(status.volume).toBe(-22);
    expect(status.preset).toBe(2);
    expect(status.channelMutes).toEqual([true, false, true]);
    const request = panel.requests.find((r) => r[0] === 5 && r[1] === 0)!;
    expect(request[23]).toBe(0);
    expect(panel.requests.some((r) => r[0] === 4)).toBe(false);
  });

  it('reports fresh numeric module classification under a read-only exclusive reservation', async () => {
    const { panel, session } = fixture(bit('deviceSettings'), 1),
      before = panel.status.slice();
    const [first] = await Promise.all([session.protection(), session.status()]);
    expect(first.identity.serial).toBe('TEST');
    expect(first.operations.deviceSettings.allowed).toBe(true);
    panel.deviceConfiguration[11] = 2;
    const second = await session.protection();
    expect(second.moduleType).toBe(2);
    expect(second.operations.deviceSettings.allowed).toBe(false);
    expect(panel.status).toEqual(before);
    expect(writes(panel)).toHaveLength(0);
    expect(panel.maxConcurrent).toBe(1);
  });

  it('preflights composite patches before any write and rechecks a module change at commit', async () => {
    const { panel, session } = fixture(bit('deviceSettings'), 1);
    await expect(session.preflightControls({ mute: true, bridge: false })).rejects.toThrow(
      'bridge',
    );
    expect(writes(panel)).toHaveLength(0);
    await session.preflightControls({ oledMaximumBrightness: 0 });
    panel.deviceConfiguration[11] = 2;
    await expect(session.setControls({ oledMaximumBrightness: 0 })).rejects.toThrow('non-OEM');
    expect(writes(panel)).toHaveLength(0);
  });

  it('allows OEM settings and independently refuses protected configuration restoration', async () => {
    const { panel, session } = fixture(bit('deviceSettings') | bit('dacFilter'), 1);
    await session.setControls({ soundQuality: 3, firMode: 0, standbyLedMode: 0 });
    expect(panel.displayUpdates).toBe(1);
    expect(decodeStatus(panel.status).locked).toBe(true);
    await expect(session.preflightOperation('manufacturing')).rejects.toThrow('unlocked panel');
    expect(panel.requests.some((r) => r[0] === 0x66 && r[1] === 1)).toBe(false);
  });

  it('preflights limiter metadata without writes, then permits only the native settings+limiter intersection', async () => {
    const { panel, session } = fixture(bit('deviceSettings') | bit('softclipLimiter'), 1);
    panel.deviceConfiguration = encodeLimiter(
      decodeLimiter(panel.deviceConfiguration),
      channels,
      false,
    );
    panel.deviceConfiguration[1] = 0;
    const original = panel.deviceConfiguration.slice();
    await session.preflightLimiter(channels);
    expect(writes(panel)).toHaveLength(0);
    await session.setLimiter(channels.map((c) => ({ ...c, watts: 30 })));
    expect(panel.deviceConfiguration.slice(2, 20)).toEqual(original.slice(2, 20));
    expect(decodeLimiter(panel.deviceConfiguration).channels.map((c) => c.watts)).toEqual([
      30, 30, 30,
    ]);
    expect(vi.mocked(saveConfigurationBackup)).toHaveBeenCalledOnce();
    expect(decodeStatus(panel.status).muted).toBe(true);
    expect(decodeStatus(panel.status).locked).toBe(true);
  });

  it('refuses malformed or unavailable limiter changes before mute or configuration writes', async () => {
    const a = fixture(bit('deviceSettings'), 1),
      b = fixture(0xffff, 0),
      c = fixture(0xffff, 1);
    await expect(a.session.setLimiter(channels)).rejects.toThrow('softclipLimiter');
    await expect(b.session.setLimiter(channels)).rejects.toThrow('non-OEM');
    await expect(
      c.session.preflightLimiter(channels.map((v) => ({ ...v, ohms: 0 }))),
    ).rejects.toThrow('Invalid limiter');
    for (const { panel } of [a, b, c]) expect(writes(panel)).toHaveLength(0);
  });

  it('rejects an attempt to use limiter permission to overwrite manufacturing bytes', async () => {
    const { panel, session } = fixture(bit('deviceSettings') | bit('softclipLimiter'), 1),
      target = panel.deviceConfiguration.slice();
    target[15] ^= 1;
    await expect(
      session.exclusive(() => session.writeConfigurationInternal(target, 'softclipLimiter')),
    ).rejects.toThrow('cannot overwrite');
    expect(writes(panel)).toHaveLength(0);
  });

  it('refuses locked non-OEM power requests before even sending recovery mute', async () => {
    const { panel, session } = fixture(bit('deviceSettings'), 0);
    await expect(session.setPower(true)).rejects.toThrow('non-OEM');
    expect(writes(panel)).toHaveLength(0);
    expect(panel.requests.some((r) => r[0] === 8)).toBe(false);
  });

  it('allows IIR/FIR preparation on a locked commercial amp only with uploadbit7', async () => {
    const { panel, session } = fixture(bit('uploadFilters'), 0),
      preset = newProject().presets[0];
    await session.exclusive(() => session.prepareInternal(1, preset));
    await session.exclusive(() => prepareFirInternal(session, 1, preset));
    expect(writes(panel)).toHaveLength(0);
    panel.status[24] = 0;
    await expect(session.exclusive(() => session.prepareInternal(1, preset))).rejects.toThrow(
      'uploadFilters',
    );
    expect(writes(panel)).toHaveLength(0);
  });

  it('enforces separate EQ versus IIR/FIR sector and EEPROM authorization before first erase/write', async () => {
    const { panel, session } = fixture(bit('equalizer'), 1);
    await session.exclusive(() =>
      session.prepareEqInternal(1, newProject().presets[0].inputEq, false),
    );
    await expect(
      session.exclusive(() => session.writeSectorInternal(0x22000, new Uint8Array(4096))),
    ).rejects.toThrow('uploadFilters');
    await expect(
      session.exclusive(() => writeFirNameInternal(session, 0x200, new Uint8Array(32))),
    ).rejects.toThrow('uploadFilters');
    expect(writes(panel)).toHaveLength(0);
    const commercial = fixture(bit('equalizer'), 0);
    await expect(
      commercial.session.uploadEq(1, newProject().presets[0].inputEq, true),
    ).rejects.toThrow('non-OEM');
    expect(writes(commercial.panel)).toHaveLength(0);
  });

  it('prepares every amp before muting when the second lacks project or EQ permission', async () => {
    for (const eq of [false, true]) {
      const left = fixture(eq ? bit('equalizer') : bit('uploadFilters'), eq ? 1 : 0, 2, 'L'),
        right = fixture(0, 1, 2, 'R'),
        project = newProject();
      const operation = eq
        ? uploadEqBankPair(
            [left, right].map(({ session }) => ({
              session,
              bank: project.presets.map((p) => ({ bands: p.inputEq, enabled: true })),
            })),
          )
        : uploadProjectPair(
            [left, right].map(({ session }) => ({
              session,
              name: 'Permission test',
              presets: project.presets,
            })),
          );
      await expect(operation).rejects.toThrow('permission denied');
      expect(writes(left.panel)).toHaveLength(0);
      expect(writes(right.panel)).toHaveLength(0);
    }
  });

  it('verifies all three protected commercial-panel IIR presets and restores active preset with uploadbit7 only', async () => {
    const { panel, session } = fixture(bit('uploadFilters'), 0),
      project = newProject();
    panel.status[2] = 2;
    project.presets.forEach((preset, i) => {
      preset.channels[0].gain = -i - 1;
    });
    await uploadProjectPair([{ session, name: 'Protected IIR', presets: project.presets }]);
    expect(panel.writes).toBe(3);
    expect(panel.name).toBe('Protected IIR');
    expect(decodeStatus(panel.status)).toMatchObject({ locked: true, muted: true, preset: 2 });
    expect(panel.status[24]).toBe(bit('uploadFilters'));
    expect(hex(panel.memory.slice(0x22000, 0x22200))).not.toBe(
      hex(panel.memory.slice(0x23000, 0x23200)),
    );
    expect(panel.requests.filter((r) => r[0] === 4)).toHaveLength(0);
  }, 10000);

  it('verifies protected OEM EQ bank with Equalizer11 alone, preserving active preset and unrelated status', async () => {
    const { panel, session } = fixture(bit('equalizer'), 1),
      project = newProject();
    panel.status[2] = 3;
    panel.status[35] = 0xc5;
    const bank = project.presets.map((preset, i) => {
      preset.inputEq[0].gain = -i - 1;
      return { bands: preset.inputEq, enabled: i !== 1 };
    });
    await uploadEqBankPair([{ session, bank }]);
    expect(panel.writes).toBe(3);
    expect(panel.eqReloads).toBe(3);
    expect(panel.name).toBe('Simulator');
    expect(panel.status[35]).toBe(0xc5);
    expect([12, 13, 14].map((i) => !!(panel.status[i] & 16))).toEqual([true, false, true]);
    expect(decodeStatus(panel.status)).toMatchObject({ locked: true, muted: true, preset: 3 });
    expect(panel.status[24]).toBe(0);
    expect(panel.status[25]).toBe(8);
  }, 10000);

  it('verifies protected FIR sectors, EEPROM filename and activation with universal uploadbit7', async () => {
    const { panel, session } = fixture(bit('uploadFilters'), 0),
      preset = newProject().presets[0];
    preset.firPlacement = 'output';
    preset.channels[0].fir = {
      name: 'Protected FIR.txt',
      enabled: true,
      taps: Array.from({ length: 1500 }, (_, i) => (i === 0 ? 0.5 : i === 1 ? 0.25 : 0)),
    };
    await uploadFir(
      session,
      1,
      preset,
      () => {},
      async () => {},
    );
    expect(panel.writes).toBe(2);
    expect(panel.status[28] & 0x11).toBe(0x11);
    expect(new TextDecoder().decode(panel.eeprom.slice(0x220, 0x240)).replace(/\0.*$/s, '')).toBe(
      'Protected FIR.txt',
    );
    expect(decodeStatus(panel.status)).toMatchObject({ locked: true, muted: true });
  }, 10000);

  it('rechecks limiter permission after durable backup before any mute or configuration write', async () => {
    const { panel, session } = fixture(bit('deviceSettings') | bit('softclipLimiter'), 1);
    vi.mocked(saveConfigurationBackup).mockImplementationOnce(async () => {
      panel.status[24] = 0;
    });
    await expect(session.setLimiter(channels)).rejects.toThrow('permission denied');
    expect(writes(panel)).toHaveLength(0);
  });
});
