import { describe, expect, it } from 'vitest';
import { packet } from '../src/hardware/codec';
import {
  buildDeviceDefaultsPlan,
  buildDeviceDefaultsRecoveryPlan,
  deviceDefaultsStatusMask,
  verifyDeviceDefaultsStep,
  type DeviceDefaultsSnapshot,
} from '../src/hardware/device-defaults';

function fixture(): DeviceDefaultsSnapshot {
  const status = packet(5),
    configuration = packet(6, 22, 5, 1),
    deviceConfiguration = packet(0x66);
  status[1] = 4;
  status[2] = 2;
  new DataView(status.buffer).setInt16(3, -625, true);
  status[6] = 5;
  status[7] = 1;
  status[8] = 91;
  status[9] = status[10] = 255;
  status[11] = 0xbc;
  status.set([0xf1, 0xa3, 0xf6], 12);
  new DataView(status.buffer).setInt16(15, 123, true);
  new DataView(status.buffer).setInt16(17, -456, true);
  new DataView(status.buffer).setInt16(19, 789, true);
  new DataView(status.buffer).setInt16(21, -20000, true);
  status[23] = 255; // RX includes unrelated/one-shot bits: never replay these.
  status[24] = 0xa9;
  status[25] = 0x73;
  status[27] = 0xab;
  status.set([0xde, 0x31, 0x9f, 0xbd], 28);
  status[35] = 0x92;
  status[36] = 0xdb;
  status[51] = 0;
  configuration[4] = 16;
  new DataView(configuration.buffer).setUint16(15, 5, true);
  new DataView(configuration.buffer).setUint16(17, 7, true);
  for (let i = 2; i < 64; i++) deviceConfiguration[i] = (i * 7 + 13) & 255;
  deviceConfiguration[10] = 5;
  deviceConfiguration[11] = 1;
  deviceConfiguration[12] = 22;
  deviceConfiguration[13] = 1;
  return {
    identity: { serial: 'H05U-SYNTHETIC-DEFAULTS', product: 22, core: '5.1', firmware: '5.7' },
    status,
    configuration,
    deviceConfiguration,
  };
}
const words = (b: Uint8Array, start: number) =>
  [0, 1, 2].map((i) => new DataView(b.buffer, b.byteOffset).getInt32(start + i * 4, true));

describe('native FusionAmp Defaults pure plan', () => {
  it('emits the complete four reports in native order, independently confirming decimal-to-Q24 fixtures', () => {
    const original = fixture(),
      plan = buildDeviceDefaultsPlan(original);
    expect(plan.steps.map((s) => s.id)).toEqual(['settings', 'mixer', 'configuration', 'display']);
    expect(plan.steps.map((s) => [s.request[0], s.request[1], s.request[23]])).toEqual([
      [5, 0, 4],
      [5, 0, 0],
      [0x66, 1, 2],
      [5, 0, 8],
    ]);
    // These are independently computed from native six-decimal Text values, not limiterThreshold().
    expect(Math.round(2.871783 * 16777216)).toBe(48180524);
    expect(Math.round(5.401847 * 16777216)).toBe(90627954);
    expect(words(plan.steps[2].request, 20)).toEqual([48180524, 48180524, 90627954]);
    expect(words(plan.steps[2].request, 32)).toEqual([16273900, 16273900, 16273900]);
    expect(words(plan.steps[2].request, 44)).toEqual([16776377, 16776377, 16776377]);
    expect(Array.from(plan.steps[2].request.subarray(56, 62))).toEqual([40, 40, 40, 20, 20, 20]);
    for (const { request } of plan.steps.filter((s) => s.request[0] === 5)) {
      expect(request[6]).toBe(0x85);
      expect(Array.from(request.subarray(9, 11))).toEqual([9, 0]);
      expect(Array.from(request.subarray(12, 15))).toEqual([0x51, 0x03, 0x56]);
      expect(Array.from(request.subarray(15, 21))).toEqual([0, 0, 0, 0, 0, 0]);
      expect(new DataView(request.buffer).getInt16(21, true)).toBe(-4000);
      expect(request[7]).toBe(0);
      expect(request[8]).toBe(15);
      expect(request[27]).toBe(0);
    }
    expect(plan.steps[0].request[11]).toBe(0xbc);
    expect(plan.steps[1].request[11]).toBe(0xba); // MFB and reserved bits retained, route 2.
    expect(plan.steps[3].request[35]).toBe(0xf6);
    expect(plan.steps[3].request[36]).toBe(0xd8);
    expect(plan.after).toMatchObject({
      bridge: false,
      master: true,
      signalDetection: true,
      wakeOnLine: true,
      muted: true,
      routing: 2,
      startupVolume: -40,
      powerOffMinutes: 15,
      detectionOn: 0,
      detectionOff: 0,
      sourceLocks: [false, false, false],
      volumeLocks: [false, false, false],
    });
    expect(plan.after.limiterChannels.map((c) => [c.watts, c.ohms])).toEqual([
      [100, 4],
      [100, 4],
      [100, 4],
    ]);
  });

  it('preserves manufacturing, source, EQ/ADC/FIR, OEM and runtime state without echoing telemetry', () => {
    const original = fixture(),
      plan = buildDeviceDefaultsPlan(original);
    for (const { request } of plan.steps.filter((s) => s.request[0] === 5)) {
      for (const i of [2, 3, 4, 24, 25, 28, 29, 30, 31])
        expect(request[i]).toBe(original.status[i]);
      for (const i of [1, 5, 26, 32, 33, 34, 37, 46, 48, 50, 51, 63]) expect(request[i]).toBe(0);
    }
    for (const i of [...Array.from({ length: 18 }, (_, i) => i + 2), 62, 63])
      expect(plan.steps[2].request[i]).toBe(original.deviceConfiguration[i]);
    expect(plan.after.presetSources).toEqual(plan.before.presetSources);
    expect(plan.after.eqEnabled).toEqual(plan.before.eqEnabled);
    expect(plan.after.firFlags).toEqual(plan.before.firFlags);
    expect(plan.after.firPlacements).toEqual(plan.before.firPlacements);
    expect(plan.after.volume).toBe(-6.25);
    expect(original.status[6]).toBe(5);
    expect(original.status[9]).toBe(255);
  });

  it('retains the native unconditional display step without OLED and disabled-output threshold 20', () => {
    const input = fixture();
    input.configuration[4] = 0;
    input.deviceConfiguration[13] = 0;
    const plan = buildDeviceDefaultsPlan(input);
    expect(plan.after.oledCapable).toBe(false);
    expect(plan.steps[3].request[35]).toBe(0xf6);
    expect(plan.steps[3].request[23]).toBe(8);
    expect(words(plan.steps[2].request, 20)).toEqual([48180524, 48180524, 335544320]);
  });

  it('reconstructs detection from two-bit native indices and restores the full captured owned byte on recovery', () => {
    const original = fixture();
    original.status[27] = 0xab;
    const forward = buildDeviceDefaultsPlan(original);
    expect(forward.before.detectionOn).toBe(3);
    expect(forward.before.detectionOff).toBe(2);
    expect(forward.after.detectionOn).toBe(0);
    expect(forward.after.detectionOff).toBe(0);
    for (const step of forward.steps.filter((step) => step.request[0] === 5)) {
      expect(step.request[27]).toBe(0);
      expect(step.verification.mask[27]).toBe(255);
    }
    const current = forward.steps[3].request;
    current[27] = 0x70;
    const restored = buildDeviceDefaultsRecoveryPlan(original, current, forward.steps[2].request);
    expect(restored.steps[1].request[27]).toBe(0xab);
    expect(restored.steps[1].request[23]).toBe(0x0c);
    expect(restored.after.detectionOn).toBe(3);
    expect(restored.after.detectionOff).toBe(2);
    expect(original.status[27]).toBe(0xab);
  });

  it('provides detached immutable proposals and independent copies of masks', () => {
    const original = fixture(),
      plan = buildDeviceDefaultsPlan(original);
    original.status.fill(0);
    original.deviceConfiguration.fill(0);
    plan.snapshot.status.fill(0);
    plan.steps[0].request.fill(0);
    plan.steps[0].verification.mask.fill(0);
    plan.steps[0].verification.expected.fill(0);
    expect(plan.snapshot.status[2]).toBe(2);
    expect(plan.steps[0].request[0]).toBe(5);
    expect(plan.steps[0].verification.mask[0]).toBe(255);
    expect(plan.steps[0].verification.expected[0]).toBe(5);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.after.sourceLocks)).toBe(true);
    const mask = deviceDefaultsStatusMask();
    mask.fill(0);
    expect(deviceDefaultsStatusMask()[0]).toBe(255);
  });

  it.each(['status', 'configuration', 'deviceConfiguration'] as const)(
    'rejects truncated %s',
    (key) => {
      const input = fixture();
      input[key] = input[key].slice(0, 63);
      expect(() => buildDeviceDefaultsPlan(input)).toThrow(/complete/);
    },
  );
  it('requires exact protocol, identity and absolute unlock rather than OEM permissions', () => {
    const changes: ((s: DeviceDefaultsSnapshot) => void)[] = [
      (s) => {
        s.status[0] = 6;
      },
      (s) => {
        s.status[2] = 0;
      },
      (s) => {
        s.configuration[1] = 21;
      },
      (s) => {
        s.configuration[3] = 2;
      },
      (s) => {
        s.deviceConfiguration[10] = 6;
      },
      (s) => {
        s.deviceConfiguration[12] = 23;
      },
      (s) => {
        s.identity.product = 23;
      },
      (s) => {
        s.identity.core = '5.2';
      },
      (s) => {
        s.identity.firmware = '5.82';
      },
      (s) => {
        s.identity.serial = '';
      },
      (s) => {
        s.identity.serial = 'bad\nserial';
      },
      (s) => {
        s.status[51] = 2;
        s.status[24] = s.status[25] = 255;
      },
    ];
    for (const change of changes) {
      const input = fixture();
      change(input);
      expect(() => buildDeviceDefaultsPlan(input)).toThrow();
    }
    const verified = fixture();
    verified.status[51] = 6;
    expect(() => buildDeviceDefaultsPlan(verified)).not.toThrow();
    const later = fixture();
    later.identity.firmware = '5.82';
    new DataView(later.configuration.buffer).setUint16(17, 82, true);
    expect(() => buildDeviceDefaultsPlan(later)).not.toThrow(); // Static host format, no physical qualification claim.
  });
});

describe('Defaults recovery ownership and readback', () => {
  it('restores only action-owned fields, preserving fresh security/runtime/filter state and manufacturing', () => {
    const original = fixture(),
      forward = buildDeviceDefaultsPlan(original);
    const current = forward.steps[3].request,
      current66 = forward.steps[2].request;
    current[2] = 3;
    new DataView(current.buffer).setInt16(3, -9600, true);
    current[6] = 0x82;
    current[11] = 0x52;
    current.set([0x42, 0x14, 0x65], 12);
    current[24] = 0x11;
    current[25] = 0x22;
    current[27] = 0x70;
    current.set([0x11, 0x22, 0x33, 0x55], 28);
    current[36] = 0x98;
    current[51] = 0;
    current66[14] = 0x77;
    current66[62] = 0x87;
    const plan = buildDeviceDefaultsRecoveryPlan(original, current, current66);
    expect(plan.steps.map((s) => s.id)).toEqual(['restore-configuration', 'restore-settings']);
    const restored = plan.steps[1].request;
    for (const i of [7, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22, 35])
      expect(restored[i]).toBe(original.status[i]);
    for (const i of [2, 3, 4, 6, 24, 25, 28, 29, 30, 31]) expect(restored[i]).toBe(current[i]);
    expect(restored[11]).toBe(0x54);
    expect(Array.from(restored.subarray(12, 15))).toEqual([0xe2, 0xb4, 0xe5]);
    expect(restored[27]).toBe(0xab);
    expect(restored[36]).toBe(0x9b);
    expect(restored[23]).toBe(12);
    expect(restored[51]).toBe(0);
    expect(Array.from(plan.steps[0].request.subarray(20, 62))).toEqual(
      Array.from(original.deviceConfiguration.subarray(20, 62)),
    );
    expect(plan.steps[0].request[14]).toBe(0x77);
    expect(plan.steps[0].request[62]).toBe(0x87);
    expect(plan.after.muted).toBe(true);
    expect(plan.after.preset).toBe(3);
    expect(plan.after.volume).toBe(-96);
    expect(plan.after.firFlags).toEqual([0x11, 0x22, 0x33]);
  });

  it('refuses malformed or newly locked live recovery packets before producing any plan', () => {
    const original = fixture(),
      current = original.status.slice();
    current[51] = 2;
    expect(() =>
      buildDeviceDefaultsRecoveryPlan(original, current, original.deviceConfiguration),
    ).toThrow(/unlocked/);
    expect(() => buildDeviceDefaultsRecoveryPlan(original, original.status, packet(0x66))).toThrow(
      /protocol/,
    );
  });

  it('verifies writable readback while ignoring RX-only telemetry, and accepts an explicit mute step', () => {
    const plan = buildDeviceDefaultsPlan(fixture()),
      settingsStep = plan.steps[0];
    const read = settingsStep.request;
    read[1] = 6;
    read[23] = 255;
    read[46] = 9;
    read[51] = 6;
    expect(() => verifyDeviceDefaultsStep(settingsStep, read)).not.toThrow();
    read[24] ^= 1;
    expect(() => verifyDeviceDefaultsStep(settingsStep, read)).toThrow(/byte 24/);
    const config = plan.steps[2].request;
    config[1] = 0;
    expect(() => verifyDeviceDefaultsStep(plan.steps[2], config)).not.toThrow();
    config[62] ^= 1;
    expect(() => verifyDeviceDefaultsStep(plan.steps[2], config)).toThrow(/byte 62/);
    expect(() =>
      verifyDeviceDefaultsStep({ ...settingsStep, id: 'mute' }, settingsStep.request),
    ).not.toThrow();
    expect(() => verifyDeviceDefaultsStep(settingsStep, new Uint8Array(63))).toThrow(/frame/);
  });

  it('fences complete writable bytes including unmodeled high bits', () => {
    const target = buildDeviceDefaultsPlan(fixture()).steps[0];
    for (const [offset, bit] of [
      [6, 0x40],
      [11, 0x80],
      [27, 0x80],
      [31, 0x80],
    ]) {
      const changed = target.request;
      changed[offset] ^= bit;
      expect(() => verifyDeviceDefaultsStep(target, changed)).toThrow(`byte ${offset}`);
    }
    const canonical = target.request;
    canonical[36] ^= 4;
    expect(() => verifyDeviceDefaultsStep(target, canonical)).not.toThrow();
  });
});
