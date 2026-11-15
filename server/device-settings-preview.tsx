/** Isolated developer harness: every session below owns a synthetic transport. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DeviceSettings from '../src/components/DeviceSettings';
import '../src/app/globals.css';
import { decodeStatus, hex, type Controls, type PanelStatus } from '../src/hardware/codec';
import { decodeLimiter, encodeLimiter } from '../src/hardware/device-settings';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

type Slot = 'left' | 'right';
interface Profile {
  panel: SimulatedPanel;
  session: PanelSession;
  identity: Identity;
  status: PanelStatus;
  capabilityRevision: number;
}
const slots: Slot[] = ['left', 'right'];
const label = (slot: Slot) => (slot === 'left' ? 'Left' : 'Right');
function createProfiles(): Record<Slot, Profile> {
  return Object.fromEntries(
    slots.map((slot) => {
      const left = slot === 'left',
        panel = new SimulatedPanel(`SIMULATED-${slot.toUpperCase()}`);
      panel.name = `${label(slot)} synthetic design`;
      panel.configuration[4] = left ? 0x10 : 0;
      panel.status[35] = left ? 0xc5 : 0x93;
      panel.status[36] = left ? 0xda : 0xd9;
      // Distinct synthetic health snapshots. No physical transport is created.
      panel.status[51] = left ? 0x01 : 0; // Signal alone is not password protection.
      panel.status[54] = left ? 32 : 200;
      panel.status[55] = left ? 27 : 251;
      panel.status[56] = left ? 29 : 81;
      panel.status[57] = left ? 0 : 0x01;
      panel.status[58] = left ? 0 : 0x05;
      panel.status[59] = 0x02;
      panel.status[60] = left ? 0 : 0x10;
      new DataView(panel.status.buffer).setInt16(52, left ? -600 : -1200, true);
      new DataView(panel.status.buffer).setInt16(61, left ? -3000 : -5000, true);
      // Right retains values outside the native UI choices; the component must display them.
      if (!left) new DataView(panel.status.buffer).setUint16(9, (7 << 8) | (3 << 11), true);
      panel.deviceConfiguration[11] = left ? 2 : 3;
      panel.deviceConfiguration[13] = left ? 1 : 0;
      panel.deviceConfiguration[14] = left ? 0x81 : 0;
      panel.deviceConfiguration[15] = left ? 72 : 68;
      const view = new DataView(panel.deviceConfiguration.buffer);
      view.setInt16(16, left ? -1234 : 2345, true);
      view.setUint16(18, left ? 400 : 0, true);
      panel.deviceConfiguration = encodeLimiter(
        decodeLimiter(panel.deviceConfiguration),
        Array.from({ length: 3 }, () => ({ watts: 25, ohms: 4, attackMs: 10, releaseMs: 250 })),
        false,
      );
      panel.deviceConfiguration[1] = 0;
      const session = new PanelSession(panel, async () => {}),
        identity: Identity = {
          serial: panel.serial,
          product: 22,
          core: '5.1',
          firmware: '5.7',
          name: panel.name,
          configuration: hex(panel.configuration),
        };
      return [
        slot,
        { panel, session, identity, status: decodeStatus(panel.status), capabilityRevision: 0 },
      ];
    }),
  ) as Record<Slot, Profile>;
}

function Preview() {
  const [profiles, setProfiles] = useState(createProfiles),
    [slot, setSlot] = useState<Slot>('left'),
    [reset, setReset] = useState(0),
    [message, setMessage] = useState('No simulated writes yet.'),
    profile = profiles[slot];
  const publish = (target: Slot, captured: Profile, status: PanelStatus) => {
    setProfiles((current) =>
      current[target].session !== captured.session
        ? current
        : {
            ...current,
            [target]: {
              ...current[target],
              status,
              identity: captured.session.identity ?? captured.identity,
            },
          },
    );
  };
  const refresh = async () => publish(slot, profile, await profile.session.status());
  const controls = async (patch: Controls) => {
    // Capture this selected role before the first await; switching roles cannot redirect a write.
    const target = slot,
      captured = profile;
    try {
      await captured.session.preflightControls(patch);
      const status = await captured.session.setControls(patch);
      publish(target, captured, status);
      setMessage(`${label(target)} simulated settings verified: ${JSON.stringify(patch)}`);
    } catch (error) {
      setMessage(`${label(target)} simulation refused: ${String(error)}`);
    }
  };
  const operate = async <T,>(description: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      setMessage(`${label(slot)} simulation: ${description}`);
      return result;
    } catch (error) {
      setMessage(`${label(slot)} simulation: ${String(error)}`);
      throw error;
    }
  };
  const setup = (patch: {
    oled?: boolean;
    protected?: boolean;
    matched?: boolean;
    moduleType?: number;
    mask?: number;
  }) => {
    if (patch.oled !== undefined)
      profile.panel.configuration[4] =
        (profile.panel.configuration[4] & ~0x10) | (patch.oled ? 0x10 : 0);
    if (patch.protected !== undefined)
      profile.panel.status[51] = (profile.panel.status[51] & ~2) | (patch.protected ? 2 : 0);
    if (patch.matched !== undefined)
      profile.panel.status[51] = (profile.panel.status[51] & ~4) | (patch.matched ? 4 : 0);
    if (patch.moduleType !== undefined) profile.panel.deviceConfiguration[11] = patch.moduleType;
    if (patch.mask !== undefined) {
      profile.panel.status[24] = patch.mask & 255;
      profile.panel.status[25] = patch.mask >> 8;
    }
    setProfiles((current) => ({
      ...current,
      [slot]: {
        ...profile,
        status: decodeStatus(profile.panel.status),
        capabilityRevision: profile.capabilityRevision + 1,
      },
    }));
  };
  return (
    <main style={{ maxWidth: 1440, margin: '0 auto', padding: 24 }}>
      <header className="feature-card" style={{ marginBottom: 16 }}>
        <h1 style={{ marginTop: 0 }}>Simulation only · no USB connection</h1>
        <p>Actual DeviceSettings component · two independent synthetic FA503 profiles</p>
        <div className="button-row">
          {slots.map((target) => (
            <button key={target} aria-pressed={slot === target} onClick={() => setSlot(target)}>
              {label(target)} profile{slot === target ? ' · selected' : ''}
            </button>
          ))}
          <label>
            <input
              type="checkbox"
              checked={!!(profile.panel.configuration[4] & 0x10)}
              onChange={(e) => setup({ oled: e.target.checked })}
            />{' '}
            Advertise OLED
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!(profile.panel.status[51] & 2)}
              onChange={(e) => setup({ protected: e.target.checked })}
            />{' '}
            Password protected
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!(profile.panel.status[51] & 4)}
              onChange={(e) => setup({ matched: e.target.checked })}
            />{' '}
            Password verified
          </label>
          <label>
            Module profile{' '}
            <select
              value={profile.panel.deviceConfiguration[11] === 1 ? 1 : 0}
              onChange={(e) => setup({ moduleType: Number(e.target.value) })}
            >
              <option value={0}>Standard · not OEM</option>
              <option value={1}>OEM · module 1</option>
            </select>
          </label>
          <label>
            Stored OEM mask{' '}
            <input
              key={`${slot}:${reset}:${profile.capabilityRevision}`}
              aria-label="Synthetic stored OEM mask"
              style={{ width: 88, fontFamily: 'monospace' }}
              defaultValue={`0x${(profile.panel.status[24] | (profile.panel.status[25] << 8)).toString(16).padStart(4, '0')}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              onBlur={(e) => {
                if (/^(?:0x)?[\da-f]{1,4}$/i.test(e.target.value))
                  setup({ mask: parseInt(e.target.value.replace(/^0x/i, ''), 16) });
                else {
                  setMessage('Synthetic mask must be 0x0000 through 0xffff.');
                  e.target.value = `0x${(profile.panel.status[24] | (profile.panel.status[25] << 8)).toString(16).padStart(4, '0')}`;
                }
              }}
            />
          </label>
          <button
            onClick={() => {
              setProfiles(createProfiles());
              setReset((current) => current + 1);
              setMessage('Both simulators reset to their synthetic baselines.');
            }}
          >
            Reset simulators
          </button>
        </div>
        <table style={{ marginTop: 14, width: '100%', fontFamily: 'monospace' }}>
          <caption style={{ textAlign: 'left' }}>Protocol audit · zero-based payload bytes</caption>
          <thead>
            <tr>
              <th>Profile</th>
              <th>raw35</th>
              <th>raw36</th>
              <th>Module</th>
              <th>Stored mask</th>
              <th>raw51</th>
              <th>Display updates</th>
              <th>05 writes</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((target) => {
              const panel = profiles[target].panel;
              return (
                <tr key={target}>
                  <th>{label(target)}</th>
                  <td>0x{panel.status[35].toString(16).padStart(2, '0')}</td>
                  <td>0x{panel.status[36].toString(16).padStart(2, '0')}</td>
                  <td>{panel.deviceConfiguration[11]}</td>
                  <td>
                    0x{(panel.status[24] | (panel.status[25] << 8)).toString(16).padStart(4, '0')}
                  </td>
                  <td>0x{panel.status[51].toString(16).padStart(2, '0')}</td>
                  <td>{panel.displayUpdates}</td>
                  <td>{panel.requests.filter((r) => r[0] === 5 && r[1] === 0).length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p role="status" style={{ marginBottom: 0 }}>
          {message}
        </p>
      </header>
      <DeviceSettings
        key={`${slot}:${profile.identity.serial}:${profile.capabilityRevision}:${reset}`}
        live={profile}
        controls={controls}
        operate={operate}
        refresh={refresh}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
