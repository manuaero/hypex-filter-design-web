/** Isolated development QA. Every amp and USB descriptor below is synthetic. */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LiveEqToggle from '../src/components/LiveEqToggle';
import FirmwarePanel from '../src/components/firmware-panel';
import { createFirmwareWorkspace } from '../src/application/firmware-workspace';
import {
  createUsbDescriptorVerifier,
  type UsbDescriptorDevice,
} from '../src/hardware/usb-descriptor';
import { decodeStatus, hex, type PanelStatus } from '../src/hardware/codec';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { Slot } from '../src/domain/model';
import '../src/app/globals.css';

const slots: readonly Slot[] = ['left', 'right'];
const label = (slot: Slot) => (slot === 'left' ? 'Left' : 'Right');
interface Profile {
  panel: SimulatedPanel;
  session: PanelSession;
  identity: Identity;
  status: PanelStatus;
}
type DescriptorChoice = Slot | 'wrong';
function fixtureRecord(type: number, bytes: number[], address = 0) {
  const record = [bytes.length, address >> 8, address & 255, type, ...bytes];
  record.push(-record.reduce((sum, byte) => sum + byte, 0) & 255);
  return (
    ':' +
    record
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}
const firmwareFixture =
  [
    fixtureRecord(0x80, [...Array<number>(8).fill(0), ...new TextEncoder().encode('FUSION32')]),
    fixtureRecord(0x81, [2]),
    fixtureRecord(4, [0, 0]),
    ...Array.from({ length: 8 }, (_, index) =>
      fixtureRecord(0, [index, 255 - index], 0x680 + index * 2),
    ),
    fixtureRecord(1, []),
  ].join('\r\n') + '\r\n';

function createSimulation() {
  const profiles = Object.fromEntries(
    slots.map((slot) => {
      const panel = new SimulatedPanel(`SIMULATED-${slot.toUpperCase()}`);
      panel.name = `${label(slot)} synthetic design`;
      panel.deviceConfiguration[11] = slot === 'left' ? 1 : 0;
      panel.status[51] = 2; // Protected, no verified password.
      panel.status[24] = slot === 'left' ? 0 : 255;
      panel.status[25] = slot === 'left' ? 8 : 255;
      for (let preset = 1; preset <= 3; preset++) panel.status[11 + preset] &= ~16;
      const session = new PanelSession(panel, async () => {}),
        identity: Identity = {
          serial: panel.serial,
          product: 22,
          core: '5.1',
          firmware: '5.7',
          name: panel.name,
          configuration: hex(panel.configuration),
        };
      return [slot, { panel, session, identity, status: decodeStatus(panel.status) }];
    }),
  ) as Record<Slot, Profile>;
  const runtime = {
    profiles,
    slot: 'left' as Slot,
    choice: 'left' as DescriptorChoice,
    holdChooser: false,
    revoked: { left: false, right: false },
    busy: { left: false, right: false },
    statusGeneration: { left: 0, right: 0 },
    audit: {
      left: { verified05: 0, chooser: 0, getDevices: 0 },
      right: { verified05: 0, chooser: 0, getDevices: 0 },
    },
    grants: new Map<string, { role: Slot | 'wrong'; device: UsbDescriptorDevice }>(),
    held: [] as {
      resolve: (device: UsbDescriptorDevice) => void;
      reject: (error: Error) => void;
      device: UsbDescriptorDevice;
      role: Slot;
      choice: DescriptorChoice;
    }[],
    changed: () => {},
  };
  const grant = (device: UsbDescriptorDevice, choice: DescriptorChoice) => {
    runtime.grants.set(device.serialNumber!, { role: choice, device });
    runtime.changed();
    return device;
  };
  // This is an injected object with just two metadata methods. It never reads
  // navigator.usb, opens a browser chooser, or exposes a USB/HID transport.
  const descriptorApi = {
    requestDevice: async () => {
      const role = runtime.slot,
        choice = runtime.choice,
        device: UsbDescriptorDevice = {
          vendorId: 0x345e,
          productId: 0x03e8,
          serialNumber:
            '0303A:' +
            (choice === 'wrong' ? 'UNRELATED-SYNTHETIC-DEVICE' : profiles[choice].identity.serial),
        };
      runtime.audit[role].chooser++;
      if (!runtime.holdChooser) return grant(device, choice);
      return new Promise<UsbDescriptorDevice>((resolve, reject) => {
        runtime.held.push({
          resolve: (selected) => resolve(grant(selected, choice)),
          reject,
          device,
          role,
          choice,
        });
        runtime.changed();
      });
    },
    getDevices: async () => {
      runtime.audit[runtime.slot].getDevices++;
      runtime.changed();
      return [...runtime.grants.values()]
        .filter((entry) => entry.role === 'wrong' || !runtime.revoked[entry.role])
        .map((entry) => entry.device);
    },
  };
  const verifier = createUsbDescriptorVerifier({
      binding: (slot) => runtime.profiles[slot].identity,
      usb: () => descriptorApi,
    }),
    workspace = createFirmwareWorkspace({
      binding: (slot) => runtime.profiles[slot].identity,
      descriptor: (slot) => verifier.getSnapshot()[slot].proof,
    });
  return { ...runtime, verifier, workspace, runtime };
}
type Simulation = ReturnType<typeof createSimulation>;

function Preview() {
  const [simulation, setSimulation] = useState(createSimulation),
    [slot, setSlot] = useState<Slot>('left'),
    [, render] = useState(0),
    [message, setMessage] = useState(
      'Synthetic baseline. No physical USB, HID, microphone or audio.',
    ),
    current = useRef<Simulation>(simulation),
    runtime = simulation.runtime,
    profile = runtime.profiles[slot];
  current.current = simulation;
  runtime.slot = slot;
  runtime.changed = () => {
    if (current.current === simulation) render((version) => version + 1);
  };
  const publish = (target: Slot, captured: Profile, generation: number, status: PanelStatus) => {
    if (
      current.current !== simulation ||
      runtime.profiles[target].session !== captured.session ||
      runtime.statusGeneration[target] !== generation
    )
      return;
    runtime.profiles[target] = {
      ...captured,
      status,
      identity: captured.session.identity ?? captured.identity,
    };
    runtime.changed();
  };
  const changeEq = async (preset: number, enabled: boolean) => {
    const target = slot,
      captured = profile,
      generation = ++runtime.statusGeneration[target];
    runtime.busy[target] = true;
    runtime.changed();
    try {
      const proposal = { presetEq: { preset, enabled } };
      await captured.session.preflightControls(proposal);
      const status = await captured.session.setControls(proposal);
      if (current.current !== simulation || runtime.profiles[target].session !== captured.session)
        return;
      runtime.audit[target].verified05++;
      publish(target, captured, generation, status);
      setMessage(
        `${label(target)} simulated preset ${preset} EQ ${enabled ? 'enabled' : 'bypassed'}; settings readback verified.`,
      );
    } catch (error) {
      if (current.current === simulation)
        setMessage(`${label(target)} simulation refused: ${String(error)}`);
    } finally {
      if (current.current === simulation && runtime.profiles[target].session === captured.session) {
        runtime.busy[target] = false;
        runtime.changed();
      }
    }
  };
  const stage = async () => {
    const target = slot,
      workspace = simulation.workspace,
      token = workspace.captureTarget(target);
    try {
      await workspace.inspect(target, firmwareFixture, `simulation-${target}.hex`, token);
      if (current.current === simulation)
        setMessage(
          `${label(target)} generated fixture staged. Firmware programming remains unavailable.`,
        );
    } catch (error) {
      if (current.current === simulation) setMessage(String(error));
    }
  };
  const setupMatched = (matched: boolean) => {
    // A direct test-profile mutation, not a password command or verification.
    const target = slot,
      captured = profile,
      generation = ++runtime.statusGeneration[target];
    captured.panel.status[51] = (captured.panel.status[51] & ~4) | (matched ? 4 : 0);
    publish(target, captured, generation, decodeStatus(captured.panel.status));
  };
  const reset = () => {
    for (const target of slots) {
      simulation.verifier.clear(target);
      simulation.workspace.clear(target);
    }
    for (const held of runtime.held.splice(0)) held.reject(new Error('Simulation reset'));
    const fresh = createSimulation();
    current.current = fresh;
    setSimulation(fresh);
    setSlot('left');
    setMessage(
      'Both synthetic profiles, staged files, descriptor grants and audit counters reset.',
    );
  };
  return (
    <main style={{ maxWidth: 1320, margin: '0 auto', padding: 12 }}>
      <header className="feature-card" style={{ padding: 12, marginBottom: 10 }}>
        <h1 style={{ fontSize: 16, margin: '0 0 6px' }}>
          Simulation only · no physical USB or audio
        </h1>
        <div className="button-row" style={{ gap: 8 }}>
          {slots.map((target) => (
            <button
              key={target}
              aria-pressed={slot === target}
              onClick={() => {
                runtime.slot = target;
                setSlot(target);
              }}
            >
              {label(target)} profile
            </button>
          ))}
          <label>
            <input
              type="checkbox"
              checked={!!(profile.status.raw[51] & 4)}
              onChange={(event) => setupMatched(event.target.checked)}
            />{' '}
            Simulate password verified
          </label>
          <label>
            Injected chooser{' '}
            <select
              aria-label="Injected USB chooser result"
              value={runtime.choice}
              onChange={(event) => {
                runtime.choice = event.target.value as DescriptorChoice;
                runtime.changed();
              }}
            >
              <option value="left">Left descriptor</option>
              <option value="right">Right descriptor</option>
              <option value="wrong">Wrong descriptor</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={runtime.holdChooser}
              onChange={(event) => {
                runtime.holdChooser = event.target.checked;
                runtime.changed();
              }}
            />{' '}
            Hold fake chooser
          </label>
          <button
            disabled={!runtime.held.length}
            onClick={() => {
              const held = runtime.held.shift();
              if (held) held.resolve(held.device);
              runtime.changed();
            }}
          >
            Resolve simulated chooser ({runtime.held.length})
          </button>
          <label>
            <input
              type="checkbox"
              checked={runtime.revoked[slot]}
              onChange={(event) => {
                runtime.revoked[slot] = event.target.checked;
                runtime.changed();
              }}
            />{' '}
            Revoke selected metadata grant
          </label>
          <button onClick={reset}>Reset simulations</button>
        </div>
        <table style={{ width: '100%', marginTop: 10, fontSize: 11, fontFamily: 'monospace' }}>
          <caption style={{ textAlign: 'left' }}>
            Synthetic audit · actual components, injected providers
          </caption>
          <thead>
            <tr>
              <th>Role</th>
              <th>Module</th>
              <th>Mask</th>
              <th>raw51</th>
              <th>P1/P2/P3 EQ</th>
              <th>Verified 05</th>
              <th>05 writes</th>
              <th>Fake chooser</th>
              <th>getDevices</th>
              <th>Flash writes</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((target) => {
              const panel = runtime.profiles[target].panel,
                audit = runtime.audit[target];
              return (
                <tr key={target}>
                  <th>{label(target)}</th>
                  <td>{panel.deviceConfiguration[11]}</td>
                  <td>
                    0x{(panel.status[24] | (panel.status[25] << 8)).toString(16).padStart(4, '0')}
                  </td>
                  <td>0x{panel.status[51].toString(16).padStart(2, '0')}</td>
                  <td>
                    {[1, 2, 3]
                      .map((preset) => (panel.status[11 + preset] & 16 ? '1' : '0'))
                      .join('/')}
                  </td>
                  <td>{audit.verified05}</td>
                  <td>
                    {
                      panel.requests.filter((request) => request[0] === 5 && request[1] === 0)
                        .length
                    }
                  </td>
                  <td>{audit.chooser}</td>
                  <td>{audit.getDevices}</td>
                  <td>{panel.writes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </header>
      <section className="feature-card" style={{ padding: 12 }}>
        <div className="button-row" style={{ justifyContent: 'space-between' }}>
          <LiveEqToggle
            live={profile}
            role={label(slot)}
            busy={runtime.busy[slot]}
            onChange={changeEq}
          />
          <button onClick={() => void stage()}>Stage generated firmware</button>
        </div>
        <p className="hint" style={{ margin: '7px 0 0' }}>
          Left: protected OEM module 1, EQ mask 0x0800. Right: protected standard module, mask
          0xffff; EQ denied until simulated password verification.
        </p>
      </section>
      <FirmwarePanel
        workspace={simulation.workspace}
        slot={slot}
        descriptorVerifier={simulation.verifier}
      />
      <p role="status" style={{ fontSize: 12, margin: '10px 0 0' }}>
        {message}
      </p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
