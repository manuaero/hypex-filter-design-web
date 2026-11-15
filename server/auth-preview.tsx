/** Isolated component QA with synthetic credentials/panels only. No real I/O. */
import { useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import DeviceAuthPanel from '../src/components/DeviceAuthPanel';
import { createDeviceAuthController } from '../src/application/device-auth';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { hex } from '../src/hardware/codec';
import type { Slot } from '../src/domain/model';
import '../src/app/globals.css';

const slots = ['left', 'right'] as const;
const label = (slot: Slot) => (slot === 'left' ? 'Left' : 'Right');
function createSimulation() {
  const profiles = Object.fromEntries(
    slots.map((slot) => {
      const panel = new SimulatedPanel(`AUTH-SIM-${slot.toUpperCase()}`);
      panel.name = `${label(slot)} simulated amplifier`;
      panel.deviceConfiguration[11] = slot === 'left' ? 1 : 0;
      panel.status[51] = 2;
      panel.status[24] = slot === 'left' ? 0 : 255;
      panel.status[25] = slot === 'left' ? 0xf8 : 255;
      panel.eeprom.set(new TextEncoder().encode(`${slot}-demo`), 0x20);
      panel.eeprom.set(new TextEncoder().encode(`${slot}@example.test`), 0x50);
      const session = new PanelSession(panel, async () => {}),
        identity: Identity = {
          serial: panel.serial,
          product: 22,
          core: '5.1',
          firmware: '5.7',
          name: panel.name,
          configuration: hex(panel.configuration),
        };
      return [slot, { panel, session, identity }];
    }),
  ) as Record<Slot, { panel: SimulatedPanel; session: PanelSession; identity: Identity }>;
  const runtime = {
    profiles,
    connected: { left: true, right: true },
    generation: { left: 0, right: 0 },
  };
  const controller = createDeviceAuthController({
    binding: (slot) => (runtime.connected[slot] ? runtime.profiles[slot] : undefined),
  });
  return { ...runtime, runtime, controller };
}
type Simulation = ReturnType<typeof createSimulation>;

function Preview() {
  const [simulation, setSimulation] = useState(createSimulation),
    [slot, setSlot] = useState<Slot>('left'),
    [message, setMessage] = useState(
      'Read-only synthetic protection status. No physical devices or audio.',
    ),
    active = useRef<Simulation>(simulation);
  active.current = simulation;
  const snapshot = useSyncExternalStore(
      simulation.controller.subscribe,
      simulation.controller.getSnapshot,
      simulation.controller.getSnapshot,
    ),
    profile = simulation.profiles[slot];
  const status = async (capturedSlot: Slot) => {
    const captured = simulation,
      binding = captured.profiles[capturedSlot],
      generation = ++captured.runtime.generation[capturedSlot];
    try {
      await captured.controller.status(capturedSlot);
      if (
        active.current === captured &&
        captured.profiles[capturedSlot].session === binding.session &&
        generation === captured.runtime.generation[capturedSlot]
      )
        setMessage(
          `${label(capturedSlot)} synthetic protection read; no credential or configuration writes.`,
        );
    } catch {
      if (active.current === captured && generation === captured.runtime.generation[capturedSlot])
        setMessage(`${label(capturedSlot)} synthetic protection status unavailable.`);
    }
  };
  const matched = (value: boolean) => {
    const capturedSlot = slot,
      captured = simulation.profiles[capturedSlot];
    // A fixture mutation only. This never submits a password or verify packet.
    captured.panel.status[51] = (captured.panel.status[51] & ~4) | (value ? 4 : 0);
    void status(capturedSlot);
  };
  const connected = (value: boolean) => {
    const capturedSlot = slot;
    simulation.runtime.connected[capturedSlot] = value;
    simulation.runtime.generation[capturedSlot]++;
    simulation.controller.refreshBindings();
    setMessage(`${label(capturedSlot)} synthetic connection ${value ? 'available' : 'removed'}.`);
  };
  const reset = () => {
    simulation.controller.dispose();
    const fresh = createSimulation();
    active.current = fresh;
    setSimulation(fresh);
    setSlot('left');
    setMessage(
      'Both synthetic protection profiles, credential storage, proposals and audit counters reset.',
    );
  };
  return (
    <main style={{ maxWidth: 1320, margin: '0 auto', padding: 12 }}>
      <header className="feature-card" style={{ padding: 12, marginBottom: 10 }}>
        <h1 style={{ fontSize: 16, margin: '0 0 6px' }}>Simulation only · no USB, HID or audio</h1>
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Actual access component and controller with independent synthetic panels. Left is a
          protected OEM module; Right is a protected standard module. Example fixture passwords are
          left-demo and right-demo. No user credentials are loaded.
        </p>
        <div className="button-row">
          {slots.map((item) => (
            <button key={item} aria-pressed={slot === item} onClick={() => setSlot(item)}>
              {label(item)}
            </button>
          ))}
          <label>
            <input
              type="checkbox"
              checked={snapshot[slot].connected}
              onChange={(e) => connected(e.target.checked)}
            />
            Simulated connection
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!(profile.panel.status[51] & 4)}
              disabled={!snapshot[slot].connected || snapshot[slot].busy}
              onChange={(e) => matched(e.target.checked)}
            />
            Simulate password verified
          </label>
          <button
            disabled={!snapshot[slot].connected || snapshot[slot].busy}
            onClick={() => void status(slot)}
          >
            Read simulated protection
          </button>
          <button onClick={reset}>Reset both simulations</button>
        </div>
        <table
          style={{ width: '100%', fontSize: 11, marginTop: 8 }}
          aria-label="Synthetic operation audit"
        >
          <thead>
            <tr>
              <th>Role</th>
              <th>Module</th>
              <th>Raw51</th>
              <th>Mask</th>
              <th>Queries</th>
              <th>Verify</th>
              <th>Password writes</th>
              <th>Address writes</th>
              <th>OEM writes</th>
              <th>Flash writes</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((item) => {
              const panel = simulation.profiles[item].panel;
              return (
                <tr key={item}>
                  <td>{label(item)}</td>
                  <td>{panel.deviceConfiguration[11]}</td>
                  <td>{panel.status[51]}</td>
                  <td>
                    0x{(panel.status[24] | (panel.status[25] << 8)).toString(16).padStart(4, '0')}
                  </td>
                  <td>{panel.requests.length}</td>
                  <td>{panel.passwordVerifications}</td>
                  <td>{panel.passwordWrites}</td>
                  <td>{panel.emailWrites}</td>
                  <td>{panel.oemMaskUpdates}</td>
                  <td>{panel.writes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </header>
      <DeviceAuthPanel controller={simulation.controller} slot={slot} />
      <p role="status" style={{ fontSize: 12, marginTop: 8 }}>
        {message}
      </p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
