import { expect, it, vi } from 'vitest';
import { decodeStatus, packet } from '../src/hardware/codec';
import { decodeHealth, type PanelHealth } from '../src/hardware/health';
import { SimulatedPanel } from '../src/hardware/simulator';
import { PanelSession } from '../src/hardware/session';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { newProject } from '../src/domain/model';

function fixture() {
  return packet(5, 6, 1);
}

it('decodes native signed temperatures, signed centidB readings and fan output without mutating the source', () => {
  const raw = fixture(),
    view = new DataView(raw.buffer);
  raw[50] = 6;
  raw[51] = 0x0b; // signal + protected + signal-lost; matched is absent.
  raw[54] = 231;
  raw[55] = 251; // native signed Int8 -5.
  raw[56] = 127;
  view.setInt16(52, -1234, true);
  view.setInt16(61, -3050, true);
  const before = raw.slice(),
    padded = new Uint8Array(90);
  padded.set(raw, 13);
  const health = decodeHealth({ ...decodeStatus(raw), raw: padded.subarray(13, 77) });
  expect(health).toMatchObject({
    audioInput: 6,
    signalDetected: true,
    signalLostDetected: true,
    passwordProtected: true,
    passwordMatched: false,
    locked: true,
    temperatures: [-5, 127],
    actualVolumeDb: -12.34,
    fanOutput: 231,
    subInputLevelDb: -30.5,
  });
  expect(raw).toEqual(before);
});

// Independent native field stores aa8509..aa8676. Raw byte offsets exclude
// the report ID; field names correspond to TFAHealthStatus RTTI 9a50f4.
it.each([
  [57, 0x01, 'errors', 'temperatureSensorFailure'],
  [57, 0x02, 'errors', 'temperatureTooHigh'],
  [57, 0x04, 'errors', 'auxiliaryVoltageOutOfRange'],
  [57, 0x08, 'errors', 'dcError'],
  [57, 0x10, 'errors', 'powerFailure'],
  [57, 0x20, 'errors', 'i2cBusError'],
  [57, 0x40, 'errors', 'srcI2cError'],
  [58, 0x01, 'warnings', 'temperature'],
  [58, 0x02, 'warnings', 'analogClipping'],
  [58, 0x04, 'warnings', 'amplifierClipping'],
  [59, 0x02, 'state', 'amplifierEnabled'],
  [59, 0x04, 'state', 'deviceJustBooted'],
  [59, 0x08, 'state', 'passwordMatchedHfd'],
  [59, 0x10, 'state', 'previousButtonPressed'],
  [59, 0x20, 'state', 'signalDetected'],
  [59, 0x40, 'state', 'signalPending'],
  [59, 0x80, 'state', 'signalLostPending'],
  [60, 0x01, 'state', 'filtersUpdating'],
  [60, 0x02, 'state', 'dspSwitchOff'],
  [60, 0x04, 'state', 'testsEnabled'],
  [60, 0x08, 'state', 'standbyPending'],
  [60, 0x10, 'state', 'systemUnhealthy'],
  [60, 0x20, 'state', 'signalDetectedChanged'],
] as const)(
  'maps native status byte %i mask %i to %s.%s independently',
  (offset, mask, group, name) => {
    const raw = fixture();
    raw[offset] = mask;
    const health = decodeHealth(decodeStatus(raw));
    for (const key of ['errors', 'warnings', 'state'] as const)
      expect(
        Object.entries(health[key])
          .filter(([, active]) => active)
          .map(([flag]) => flag),
      ).toEqual(key === group ? [name] : []);
  },
);

it('preserves unrecognized signal, error, warning and state bits separately', () => {
  const raw = fixture();
  raw[51] = 0xf0;
  raw[57] = 0x80;
  raw[58] = 0xf8;
  raw[59] = 1;
  raw[60] = 0xc0;
  const health = decodeHealth(decodeStatus(raw));
  expect(health.unrecognizedBits).toEqual({
    signal: 0xf0,
    errors: 0x80,
    warnings: 0xf8,
    state1: 1,
    state2: 0xc0,
  });
  expect(Object.values(health.errors).some(Boolean)).toBe(false);
  expect(Object.values(health.warnings).some(Boolean)).toBe(false);
  expect(Object.values(health.state).some(Boolean)).toBe(false);
});

it('returns fresh and independent health for both agent targets using read-only exchanges', async () => {
  const panels = {
    left: new SimulatedPanel('HEALTH-LEFT'),
    right: new SimulatedPanel('HEALTH-RIGHT'),
  };
  const sessions = {
    left: new PanelSession(panels.left, async () => {}),
    right: new PanelSession(panels.right, async () => {}),
  };
  const connections = {
    left: {
      session: sessions.left,
      identity: await sessions.left.identify(),
      status: await sessions.left.status(),
    },
    right: {
      session: sessions.right,
      identity: await sessions.right.identify(),
      status: await sessions.right.status(),
    },
  };
  // The cached connection snapshots predate these device-state changes.
  panels.left.status[55] = 45;
  panels.left.status[57] = 0x10;
  panels.right.status[55] = 17;
  panels.right.status[58] = 0x04;
  for (const panel of Object.values(panels)) panel.requests.length = 0;
  const unexpected = vi.fn(() => {
    throw new Error('Unexpected mutation');
  });
  const adapter: ToolAdapter = {
    state: () => ({
      documents: { left: newProject('Left'), right: newProject('Right') },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
    }),
    connections: () => connections,
    edit: unexpected,
    choose: unexpected,
    undo: unexpected,
    redo: unexpected,
    connect: unexpected,
    disconnect: unexpected,
    refresh: unexpected,
    operate: async (_, fn) => fn(),
    message: () => {},
    progress: () => {},
    view: vi.fn(),
  };
  const result = (await createToolExecutor(adapter)('fusion_device_read', { target: 'both' })) as {
    ok: boolean;
    devices: { slot: 'left' | 'right'; health: PanelHealth }[];
  };
  expect(result.ok).toBe(true);
  expect(result.devices.find((device) => device.slot === 'left')?.health).toMatchObject({
    temperatures: [45, 0],
    errors: { powerFailure: true },
    warnings: { amplifierClipping: false },
  });
  expect(result.devices.find((device) => device.slot === 'right')?.health).toMatchObject({
    temperatures: [17, 0],
    errors: { powerFailure: false },
    warnings: { amplifierClipping: true },
  });
  for (const panel of Object.values(panels)) {
    expect(panel.requests.length).toBeGreaterThan(0);
    expect(
      panel.requests.every(
        (request) =>
          request[0] === 6 ||
          (request[0] === 0x66 && request[1] === 0) ||
          (request[0] === 5 && request[1] === 1) ||
          (request[0] === 3 && request[1] === 8) ||
          request[0] === 0x65 ||
          (request[0] === 8 && request[1] === 128),
      ),
    ).toBe(true);
    expect(
      panel.passwordWrites +
        panel.emailWrites +
        panel.writes +
        panel.oemMaskUpdates +
        panel.displayUpdates,
    ).toBe(0);
  }
  expect(unexpected).not.toHaveBeenCalled();
  expect(await createToolExecutor(adapter)('fusion_view', { healthDetails: true })).toEqual({
    ok: true,
  });
  expect(adapter.view).toHaveBeenCalledWith({ healthDetails: true });
});
