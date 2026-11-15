'use client';
import { useEffect, useRef, useState } from 'react';
import Numeric from './Numeric';
import HealthDiagnostics from './HealthDiagnostics';
import { Power, Radio, Settings2 } from 'lucide-react';
import { settings, type Controls, type PanelStatus } from '../hardware/codec';
import type { PanelSession, Identity } from '../hardware/session';
import { decodeProtection, type ProtectionOperation } from '../hardware/protection';
import { dspPowerOffAvailability } from '../hardware/power-availability';
import { nativeMixerAvailability } from '../hardware/native-mixer';
import type { PowerStatistics } from '../hardware/device-settings';
import {
  INPUT_SOURCES,
  FUTURE_INPUT_NOTE,
  inputSourceLabel,
  isInputSource,
} from '../hardware/input-sources';
// Native module/amplifier string tables at 0xd3ac04 and [0xd3fa40]. Unknown codes stay visible.
const MODULE_NAMES = [
  'Unknown',
  'OEM DSP3-213',
  'FA122',
  'FA123',
  'FA251',
  'FA252',
  'FA253',
  'FA501',
  'FA502',
  'FA503',
];
const AMPLIFIER_NAMES = [
  'No amplifier',
  'NC122MP',
  'NC252MP',
  'NC250MP',
  'NC500MP',
  'NC502MP',
  'NCAS500MP',
  'NCAS1000MP',
  'NC52MP',
];
function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-label">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch" />
      {label}
    </label>
  );
}
export default function DeviceSettings({
  live,
  controls,
  operate,
  refresh,
  diagnosticsExpanded,
  onDiagnosticsExpanded,
}: {
  live: { session: PanelSession; identity: Identity; status: PanelStatus };
  controls: (patch: Controls) => Promise<void>;
  operate: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
  diagnosticsExpanded?: boolean;
  onDiagnosticsExpanded?: (value: boolean) => void;
}) {
  const s = settings(live.status),
    forcedInput = live.status.raw[11 + live.status.preset] & 15,
    [power, setPower] = useState<PowerStatistics>(),
    [hardware, setHardware] = useState<Awaited<ReturnType<PanelSession['hardwareOverview']>>>(),
    [failure, setFailure] = useState('');
  const access = decodeProtection(live.status, hardware?.moduleType),
    can = (operation: ProtectionOperation) => access.operations[operation].allowed,
    powerOff = dspPowerOffAvailability(hardware?.identity.firmware ?? live.identity.firmware),
    mixer = hardware
      ? nativeMixerAvailability({
          product: hardware.product,
          moduleType: hardware.moduleType,
          core: hardware.identity.core,
          systemSetup: hardware.systemSetup,
          stereoDsp: hardware.stereoDsp,
        })
      : undefined,
    routing = live.status.raw[11] & 7,
    routingLabels = ['Left + Right', 'Right', 'Left', 'User mixer', 'Disabled'];
  const generation = useRef(0),
    mounted = useRef(true),
    currentSession = useRef(live.session),
    contentBinding = useRef({ session: live.session, epoch: 0 });
  if (contentBinding.current.session !== live.session)
    contentBinding.current = { session: live.session, epoch: contentBinding.current.epoch + 1 };
  currentSession.current = live.session;
  const load = async () => {
    const session = live.session,
      request = ++generation.current;
    const current = () =>
      mounted.current && currentSession.current === session && request === generation.current;
    try {
      const [power, overview] = await Promise.all([
        session.powerStatistics(),
        session.hardwareOverview(),
      ]);
      if (!current()) return;
      setPower(power);
      setHardware(overview);
      setFailure('');
    } catch (e) {
      if (current()) setFailure(String(e));
    }
  };
  useEffect(() => {
    mounted.current = true;
    setPower(undefined);
    setHardware(undefined);
    setFailure('');
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [live.session]);
  const perform = async (label: string, fn: () => Promise<void>) => {
    const session = live.session;
    try {
      await operate(label, fn);
      if (!mounted.current || currentSession.current !== session) return;
      await refresh();
      await load();
    } catch (e) {
      if (mounted.current && currentSession.current === session) setFailure(String(e));
    }
  };
  return (
    <div className="device-settings-workspace" key={contentBinding.current.epoch}>
      <div className="settings-grid">
        <HealthDiagnostics
          status={live.status}
          expanded={diagnosticsExpanded}
          onExpanded={onDiagnosticsExpanded}
        />
        <section className="feature-card">
          <Settings2 size={21} />
          <h2>Device information</h2>
          <dl>
            <dt>Model</dt>
            <dd>Hypex FA503 · DSP3-213</dd>
            <dt>Firmware / DSP core</dt>
            <dd>
              {live.identity.firmware} / {live.identity.core}
            </dd>
            <dt>Serial</dt>
            <dd>{live.identity.serial}</dd>
            <dt>DSP filename</dt>
            <dd>{live.identity.name}</dd>
            <dt>Active input</dt>
            <dd>{inputSourceLabel(live.status.input)}</dd>
            <dt>Protection</dt>
            <dd>
              {!access.passwordProtected
                ? 'No password set'
                : access.passwordMatched
                  ? 'Password verified'
                  : 'Password protected'}
            </dd>
            <dt>DSP power state</dt>
            <dd>{power?.mode ?? 'Reading…'}</dd>
          </dl>
          <button onClick={() => perform('Refreshing settings', async () => {})}>Refresh</button>
          <div className="button-row">
            <button
              disabled={!powerOff.available || power?.mode !== 'on' || !can('deviceSettings')}
              title={powerOff.reason}
              onClick={() =>
                perform('Stopping DSP', async () => {
                  setPower(await live.session.setPower(false));
                })
              }
            >
              <Power size={14} />
              DSP off
            </button>
            <button
              disabled={!power || power.mode === 'on' || !can('deviceSettings')}
              onClick={() =>
                perform('Starting DSP', async () => {
                  setPower(await live.session.setPower(true));
                })
              }
            >
              <Power size={14} />
              DSP on
            </button>
          </div>
          <p className="hint">
            {powerOff.reason} DSP on recovery remains unqualified; ON requests retain master mute.
          </p>
        </section>
        <section className="feature-card">
          <h2>Display & standby light</h2>
          <p className="hint">
            {hardware
              ? hardware.oledCapable
                ? 'OLED display advertised by this amplifier.'
                : 'This amplifier does not advertise an OLED display.'
              : 'Reading display capability…'}
          </p>
          <Numeric
            commitOnly
            label="OLED maximum brightness"
            value={s.oledMaximumBrightness}
            min={0}
            max={15}
            step={1}
            disabled={!hardware?.oledCapable || !can('deviceSettings')}
            onChange={(oledMaximumBrightness) => controls({ oledMaximumBrightness })}
          />
          <Numeric
            commitOnly
            label="OLED dimmed brightness"
            value={s.oledDimmedBrightness}
            min={0}
            max={15}
            step={1}
            disabled={!hardware?.oledCapable || !can('deviceSettings')}
            onChange={(oledDimmedBrightness) => controls({ oledDimmedBrightness })}
          />
          {s.oledDimmedBrightness > 6 && (
            <p className="inline-warning">
              Prolonged operation with dimmed brightness above 6 can increase OLED burn-in.
            </p>
          )}
          <label className="field-label">
            Standby LED brightness
            <select
              aria-label="Standby LED brightness"
              value={s.standbyLedMode}
              disabled={!hardware || !can('deviceSettings')}
              onChange={(e) =>
                controls({ standbyLedMode: Number(e.target.value) as 0 | 1 | 2 | 3 })
              }
            >
              <option value={0}>Off</option>
              <option value={1}>100%</option>
              <option value={2}>50%</option>
              <option value={3}>25%</option>
            </select>
          </label>
          <p className="hint">
            Standby LED brightness is available independently of the optional OLED.
          </p>
        </section>
        <section className="feature-card">
          <h2>Hardware overview</h2>
          {hardware ? (
            <dl>
              <dt>Configured amplifier</dt>
              <dd>
                {AMPLIFIER_NAMES[hardware.amplifier] ?? 'Unknown amplifier'} · code{' '}
                {hardware.amplifier}
              </dd>
              <dt>Configured module</dt>
              <dd>
                {MODULE_NAMES[hardware.moduleType] ?? 'Unknown module'} · code {hardware.moduleType}
              </dd>
              <dt>Module name</dt>
              <dd>
                {hardware.productNames
                  ? (hardware.moduleType === 1
                      ? hardware.productNames.oemName
                      : hardware.productNames.hypexName) || '(empty)'
                  : 'Unavailable'}
              </dd>
              <dt>Product code</dt>
              <dd>{hardware.product}</dd>
              <dt>Third output</dt>
              <dd>{hardware.thirdChannelEnabled ? 'Enabled' : 'Disabled'}</dd>
              <dt>Fan connected flag</dt>
              <dd>{hardware.fanConnected ? 'Yes' : 'No'}</dd>
              <dt>Stereo DSP flag</dt>
              <dd>{hardware.stereoDsp ? 'On' : 'Off'}</dd>
              <dt>OLED version · numeric</dt>
              <dd>{hardware.oledVersion}</dd>
              <dt>Temperature setting · raw</dt>
              <dd>{hardware.temperatureSetpoint}</dd>
              <dt>DSP peak setting · raw</dt>
              <dd>{hardware.dspPeakSetpoint}</dd>
              <dt>System setup</dt>
              <dd>0x{hardware.systemSetup.toString(16).padStart(2, '0')}</dd>
            </dl>
          ) : (
            <p className="hint">Reading hardware configuration…</p>
          )}
        </section>
        <section className="feature-card">
          <Radio size={21} />
          <h2>Source & routing</h2>
          <label className="field-label">
            Force input · hardware preset {live.status.preset}
            <select
              aria-label="Forced input"
              value={forcedInput}
              onChange={(e) => controls({ forceInput: Number(e.target.value) })}
            >
              {!isInputSource(forcedInput) && (
                <option value={forcedInput} disabled>
                  {inputSourceLabel(forcedInput)}
                </option>
              )}
              {INPUT_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
          {(mixer?.groupVisible ?? !hardware) && (
            <label className="field-label">
              Digital channel
              <select
                aria-label="Digital channel"
                value={routing}
                disabled={!mixer || !can('digitalLeftRight')}
                onChange={(e) => controls({ routing: Number(e.target.value) })}
              >
                {!mixer?.routingChoices.includes(routing) && (
                  <option value={routing} disabled>
                    {routingLabels[routing] ?? `Unknown (${routing})`} · reported, unavailable
                  </option>
                )}
                {(mixer?.routingChoices ?? []).map((i) => (
                  <option key={i} value={i}>
                    {routingLabels[i]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Switch
            label="Source lock"
            checked={s.sourceLock}
            disabled={s.master || !can('unknown')}
            onChange={(sourceLock) => controls({ sourceLock })}
          />
          <Switch
            label="Volume lock"
            checked={s.volumeLock}
            disabled={s.master || !can('unknown')}
            onChange={(volumeLock) => controls({ volumeLock })}
          />
          <Switch
            label="Analog input to digital output"
            checked={s.adcOutput}
            disabled={!can('unknown')}
            onChange={(adcOutput) => controls({ adcOutput })}
          />
          <Switch
            label="Absolute sub-input volume"
            checked={s.subAbsolute}
            disabled={!can('deviceSettings')}
            onChange={(subAbsolute) => controls({ subAbsolute })}
          />
          <p className="hint">
            Routing and device options apply to this amplifier. Linked master volume, mute and
            preset controls are in the bottom bar.
          </p>
          {(forcedInput === 7 || live.status.input === 7) && (
            <p className="hint">{FUTURE_INPUT_NOTE}</p>
          )}
        </section>
        <section className="feature-card">
          <Power size={21} />
          <h2>Power & signal detection</h2>
          <Switch
            label="Wake on mains power"
            checked={s.wakeOnLine}
            disabled={!s.master || !can('deviceSettings')}
            onChange={(wakeOnLine) => controls({ wakeOnLine })}
          />
          <Switch
            label="Activate signal detection"
            checked={s.signalDetection}
            disabled={!s.master || !can('deviceSettings')}
            onChange={(signalDetection) => controls({ signalDetection })}
          />
          <Numeric
            commitOnly
            label="Auto-off time"
            value={s.powerOffMinutes}
            unit="min"
            step={1}
            min={1}
            max={180}
            disabled={!s.master || !s.signalDetection || !can('deviceSettings')}
            onChange={(powerOffMinutes) => controls({ powerOffMinutes })}
          />
          {(s.powerOffMinutes < 1 || s.powerOffMinutes > 180) && (
            <p className="hint">
              Stored auto-off time {s.powerOffMinutes} min is outside HFD's 1–180 min choices;
              retained until edited.
            </p>
          )}
          <label className="field-label">
            Shutdown power mode
            <select
              value={s.standbyMode}
              disabled={!s.master || !can('deviceSettings')}
              onChange={(e) => controls({ standbyMode: Number(e.target.value) as 0 | 1 })}
            >
              <option value={0}>Standby</option>
              <option value={1}>Low power</option>
            </select>
          </label>
          <label className="field-label">
            Signal detection ON
            <select
              value={s.detectionOn}
              disabled={!s.master || !s.signalDetection || !can('deviceSettings')}
              onChange={(e) => controls({ detectionOn: Number(e.target.value) })}
            >
              {[0, 1, 2, 3].map((v) => (
                <option key={v} value={v}>
                  Sensitivity {v + 1}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Signal detection OFF
            <select
              value={s.detectionOff}
              disabled={!s.master || !s.signalDetection || !can('deviceSettings')}
              onChange={(e) => controls({ detectionOff: Number(e.target.value) })}
            >
              {[0, 1, 2, 3].map((v) => (
                <option key={v} value={v}>
                  Sensitivity {v + 1}
                </option>
              ))}
            </select>
          </label>
          <Switch
            label="Volume on start"
            checked={s.startupVolumeEnabled}
            disabled={!s.master || !can('deviceSettings')}
            onChange={(enabled) =>
              controls({
                startupVolume: enabled ? Math.max(-96, Math.min(18, s.startupVolume)) : null,
              })
            }
          />
          <Numeric
            commitOnly
            label="Startup level"
            value={s.startupVolumeEnabled ? s.startupVolume : -96}
            unit="dB"
            min={-96}
            max={18}
            step={0.1}
            precision={2}
            disabled={!s.master || !s.startupVolumeEnabled || !can('deviceSettings')}
            onChange={(startupVolume) => controls({ startupVolume })}
          />
          <p className="hint">
            {s.irRemoteMasterIndicator
              ? 'IR remote enabled · master indicator'
              : 'IR remote disabled · slave mode'}
            . Receiver presence is not confirmed by this indicator.
          </p>
          {!s.master && (
            <p className="hint">
              Slave mode clears wake-on-mains, signal detection and fixed startup volume. Dependent
              controls stay visible for context.
            </p>
          )}
        </section>
        <section className="feature-card">
          <h2>Preset volume offsets</h2>
          {s.presetOffsets.map((value, i) => (
            <Numeric
              commitOnly
              key={i}
              label={`Preset ${i + 1} offset`}
              value={value}
              unit="dB"
              min={-24}
              max={24}
              disabled={!can('deviceSettings')}
              onChange={(v) => {
                const presetOffsets = [...s.presetOffsets];
                presetOffsets[i] = v;
                void controls({ presetOffsets });
              }}
            />
          ))}
          <h2>Channel mutes</h2>
          {live.status.channelMutes.map((muted, i) => (
            <Switch
              key={i}
              label={`Output ${i + 1} mute`}
              checked={muted}
              onChange={(value) => {
                const channelMutes = [...live.status.channelMutes];
                channelMutes[i] = value;
                void controls({ channelMutes });
              }}
            />
          ))}
          <h2>Hardware preset</h2>
          <select
            aria-label="Hardware preset"
            value={live.status.preset}
            onChange={(e) => controls({ preset: Number(e.target.value) })}
          >
            {[1, 2, 3].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </section>
        <section className="feature-card">
          <h2>DAC & amplifier options</h2>
          <label className="field-label">
            DAC filter mode
            <select
              value={s.dacFilter}
              disabled={!can('dacFilter')}
              onChange={(e) => controls({ dacFilter: Number(e.target.value) })}
            >
              {s.dacFilter > 4 && (
                <option value={s.dacFilter} disabled>
                  Stored value {s.dacFilter} · outside HFD choices
                </option>
              )}
              {[
                'Short delay, sharp roll-off',
                'Short delay, slow roll-off',
                'Sharp roll-off',
                'Slow roll-off',
                'Superslow roll-off',
              ].map((label, v) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Sound quality
            <select
              aria-label="Sound quality"
              value={s.soundQuality}
              disabled={!can('dacFilter')}
              onChange={(e) => controls({ soundQuality: Number(e.target.value) })}
            >
              {s.soundQuality > 3 && (
                <option value={s.soundQuality} disabled>
                  Stored value {s.soundQuality} · outside HFD choices
                </option>
              )}
              {[1, 2, 3].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <Numeric
            commitOnly
            label="FIR filter mode"
            value={s.firMode}
            min={0}
            max={7}
            step={1}
            disabled={!can('dacFilter')}
            onChange={(firMode) => controls({ firMode })}
          />
          <p className="hint">
            Bridge changes take effect after restarting the DSP and require the matching output
            wiring and limiter configuration.
          </p>
          <h2>Analog gain jumper configuration</h2>
          <dl>
            <dt>Maximum analogue XLR input</dt>
            <dd>{s.maximumAnalogXlrVrms.toFixed(1)} Vrms</dd>
            <dt>Maximum analogue RCA input</dt>
            <dd>{s.maximumAnalogRcaVrms.toFixed(1)} Vrms</dd>
          </dl>
          <Switch
            label="XLR gain jumper +9 dB"
            checked={s.analogGainXlr}
            disabled={!can('deviceSettings')}
            onChange={(analogGainXlr) => controls({ analogGainXlr })}
          />
          <Switch
            label="RCA gain jumper +7 dB"
            checked={s.analogGainRca}
            disabled={!can('deviceSettings')}
            onChange={(analogGainRca) => controls({ analogGainRca })}
          />
          <p className="hint">
            These settings describe the physical soldered jumpers; they do not add gain
            electronically.
          </p>
        </section>
        <section className="feature-card protection-card">
          <h2>Feature access</h2>
          <p className="hint">
            {access.locked
              ? access.isOemConfigured
                ? 'Protected OEM module. Enabled permissions determine access.'
                : 'Protected standard or unknown module. Settings require a verified password.'
              : 'All operations are available with the current password state.'}
          </p>
          <dl>
            <dt>Module type</dt>
            <dd>
              {hardware
                ? `${hardware.moduleType}${access.isOemConfigured ? ' · OEM' : ''}`
                : 'Reading…'}
            </dd>
            <dt>Stored mask</dt>
            <dd>0x{access.rawMask.toString(16).padStart(4, '0')}</dd>
          </dl>
          <table className="protection-table">
            <caption>Stored OEM permissions and current access</caption>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Stored bit</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {access.items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.label}</th>
                  <td>{access.rawMask & item.mask ? 'On' : 'Off'}</td>
                  <td title={access.operations[item.id].reason}>
                    {can(item.id) ? 'Available' : 'Locked'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Source, volume, mute and preset stay available while protected. Settings children also
            require device-settings access. Unmapped controls require a verified password.
          </p>
        </section>
      </div>
      {failure && <div className="inline-error">{failure}</div>}
    </div>
  );
}
