import { expect, it } from 'vitest';
import { PanelSession, DeviceDefaultsStepError } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { buildDeviceDefaultsPlan, type DeviceDefaultsStep } from '../src/hardware/device-defaults';

const writes = (panel: SimulatedPanel) =>
  panel.requests.filter((r) => (r[0] === 5 && r[1] === 0) || (r[0] === 0x66 && r[1] === 1));
async function setup() {
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {}),
    target = await session.identify();
  panel.requests.length = 0;
  const before = await session.exclusive(() => session.captureDeviceDefaultsInternal(target));
  return { panel, session, target, before, plan: buildDeviceDefaultsPlan(before) };
}

it('captures all three read-only records and applies the narrow native display step without weakening ordinary OLED controls', async () => {
  const f = await setup();
  expect([f.before.status[0], f.before.configuration[0], f.before.deviceConfiguration[0]]).toEqual([
    5, 6, 0x66,
  ]);
  expect(writes(f.panel)).toHaveLength(0);
  await expect(f.session.setControls({ oledMaximumBrightness: 15 })).rejects.toThrow(
    'does not advertise OLED',
  );
  await f.session.exclusive(() =>
    f.session.writeDeviceDefaultsStepInternal(f.target, f.plan.steps[3]),
  );
  expect(f.panel.status[35]).toBe(0xf6);
  expect(f.panel.status[36] & 3).toBe(0);
  expect(writes(f.panel)).toHaveLength(1);
});

it('rechecks the absolute password lock after the durable attempt hook and sends nothing despite all OEM grants', async () => {
  const f = await setup();
  await expect(
    f.session.exclusive(() =>
      f.session.writeDeviceDefaultsStepInternal(f.target, f.plan.steps[0], {
        beforeSend: async () => {
          f.panel.status[51] = 2;
          f.panel.status[24] = 255;
          f.panel.status[25] = 255;
          f.panel.deviceConfiguration[11] = 1;
        },
      }),
    ),
  ).rejects.toMatchObject({
    attempted: false,
    message: 'Device Defaults requires an unlocked amplifier',
  });
  expect(writes(f.panel)).toHaveLength(0);
});

it('rejects malformed/unmuted step frames before sending and clones a valid proposal across awaited hooks', async () => {
  const f = await setup(),
    valid = f.plan.steps[0];
  const unmuted = valid.request;
  unmuted[6] &= 127;
  const malformed: DeviceDefaultsStep[] = [
    { ...valid, request: unmuted },
    { ...valid, verification: { expected: new Uint8Array(2), mask: new Uint8Array(64) } },
    { ...valid, id: 'configuration' },
  ];
  for (const step of malformed)
    await expect(
      f.session.exclusive(() => f.session.writeDeviceDefaultsStepInternal(f.target, step)),
    ).rejects.toBeInstanceOf(DeviceDefaultsStepError);
  expect(writes(f.panel)).toHaveLength(0);
  const request = valid.request,
    expected = valid.verification.expected,
    mask = valid.verification.mask;
  await f.session.exclusive(() =>
    f.session.writeDeviceDefaultsStepInternal(
      f.target,
      { ...valid, request, verification: { expected, mask } },
      {
        beforeSend: async () => {
          request.fill(0);
          expected.fill(0);
          mask.fill(0);
        },
      },
    ),
  );
  expect(f.panel.status[8]).toBe(15);
  expect(f.panel.status[6] & 128).toBe(128);
  expect(writes(f.panel)).toHaveLength(1);
});

it('does not send a configuration write after mute or firmware identity changes', async () => {
  const f = await setup();
  await expect(
    f.session.exclusive(() =>
      f.session.writeDeviceDefaultsStepInternal(f.target, f.plan.steps[2], {
        beforeSend: async () => {
          f.panel.status[6] &= 127;
        },
      }),
    ),
  ).rejects.toMatchObject({ attempted: false });
  f.panel.status[6] |= 128;
  await expect(
    f.session.exclusive(() =>
      f.session.writeDeviceDefaultsStepInternal(f.target, f.plan.steps[2], {
        beforeSend: async () => {
          new DataView(f.panel.configuration.buffer).setUint16(17, 82, true);
        },
      }),
    ),
  ).rejects.toMatchObject({ attempted: false });
  expect(writes(f.panel)).toHaveLength(0);
});
