'use client';
import { useState } from 'react';
import type { PanelStatus } from '../hardware/codec';
import { decodeHealth, type PanelHealth } from '../hardware/health';

const errorNames: Record<keyof PanelHealth['errors'], string> = {
  temperatureSensorFailure: 'Temperature sensor failure',
  temperatureTooHigh: 'Temperature too high',
  auxiliaryVoltageOutOfRange: 'Auxiliary voltage out of range',
  dcError: 'DC error',
  powerFailure: 'Power failure',
  i2cBusError: 'I²C bus error',
  srcI2cError: 'SRC I²C error',
};
const warningNames: Record<keyof PanelHealth['warnings'], string> = {
  temperature: 'Temperature warning',
  analogClipping: 'Analog clipping',
  amplifierClipping: 'Amplifier clipping',
};
const stateNames: Record<keyof PanelHealth['state'], string> = {
  amplifierEnabled: 'Amplifier enabled',
  deviceJustBooted: 'Just booted',
  passwordMatchedHfd: 'HFD password matched',
  previousButtonPressed: 'Previous button pressed',
  signalDetected: 'State signal detected',
  signalPending: 'Signal pending',
  signalLostPending: 'Signal loss pending',
  filtersUpdating: 'Updating filters',
  dspSwitchOff: 'DSP switch-off requested',
  testsEnabled: 'Tests enabled',
  standbyPending: 'Standby pending',
  systemUnhealthy: 'System unhealthy',
  signalDetectedChanged: 'Signal detection changed',
};

function Flags<T extends string>({
  name,
  values,
  names,
}: {
  name: string;
  values: Record<T, boolean>;
  names: Record<T, string>;
}) {
  return (
    <section aria-label={name}>
      <h3>{name}</h3>
      <dl className="diagnostic-flags">
        {(Object.keys(names) as T[]).map((key) => (
          <div key={key} className={values[key] ? 'reported' : ''}>
            <dt>{names[key]}</dt>
            <dd>{values[key] ? 'Yes' : 'No'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function HealthDiagnostics({
  status,
  expanded,
  onExpanded,
}: {
  status: PanelStatus;
  expanded?: boolean;
  onExpanded?: (value: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const health = decodeHealth(status),
    errors = Object.values(health.errors).filter(Boolean).length,
    warnings = Object.values(health.warnings).filter(Boolean).length,
    unknown = Object.values(health.unrecognizedBits).some(Boolean);
  return (
    <details
      className="feature-card health-diagnostics"
      open={expanded ?? localExpanded}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (expanded === undefined) setLocalExpanded(open);
        onExpanded?.(open);
      }}
    >
      <summary>
        <span>Diagnostics</span>
        <span className={errors || health.state.systemUnhealthy ? 'error' : ''}>
          {health.state.systemUnhealthy ? 'Unhealthy · ' : ''}
          {errors} {errors === 1 ? 'error' : 'errors'} · {warnings}{' '}
          {warnings === 1 ? 'warning' : 'warnings'}
        </span>
      </summary>
      <p className="small-note">Amplifier status snapshot</p>
      {unknown && (
        <p className="inline-error">The panel reported additional unrecognized status bits.</p>
      )}
      <dl className="diagnostic-values">
        <dt>Temperature 1</dt>
        <dd>{health.temperatures[0]}</dd>
        <dt>Temperature 2</dt>
        <dd>{health.temperatures[1]}</dd>
        <dt>Fan output</dt>
        <dd>{health.fanOutput}</dd>
        <dt>Actual volume</dt>
        <dd>{health.actualVolumeDb.toFixed(2)} dB</dd>
        <dt>Sub input level</dt>
        <dd>{health.subInputLevelDb.toFixed(2)} dB</dd>
        <dt>Signal detected</dt>
        <dd>{health.signalDetected ? 'Yes' : 'No'}</dd>
        <dt>Signal loss detected</dt>
        <dd>{health.signalLostDetected ? 'Yes' : 'No'}</dd>
      </dl>
      <div className="diagnostic-groups">
        <Flags name="Errors" values={health.errors} names={errorNames} />
        <Flags name="Warnings" values={health.warnings} names={warningNames} />
        <Flags name="Status" values={health.state} names={stateNames} />
      </div>
    </details>
  );
}
