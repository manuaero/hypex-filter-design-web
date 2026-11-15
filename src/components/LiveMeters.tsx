import { SLOTS, type Slot } from '../domain/model';
import type { PanelStatus } from '../hardware/codec';
import { decodeMetering, meterDisplayDb, METER_MIN_DB, METER_MAX_DB } from '../hardware/metering';

function Peak({ name, value }: { name: string; value: number | null }) {
  const displayed = meterDisplayDb(value);
  return (
    <div className="live-meter-row">
      <span>{name}</span>
      <div
        className="live-meter-track"
        role="meter"
        aria-label={name}
        aria-valuemin={METER_MIN_DB}
        aria-valuemax={METER_MAX_DB}
        aria-valuenow={displayed}
        aria-valuetext={displayed === undefined ? 'Unavailable' : `${value!.toFixed(1)} dB`}
      >
        <i
          style={{
            width: `${displayed === undefined ? 0 : ((displayed - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100}%`,
          }}
        />
      </div>
      <output>{displayed === undefined ? '—' : value!.toFixed(1)}</output>
    </div>
  );
}

export default function LiveMeters({
  connections,
  paused = false,
}: {
  connections: Partial<Record<Slot, { status: PanelStatus; identity: { serial: string } }>>;
  paused?: boolean;
}) {
  return (
    <section
      className={`live-meters${paused ? ' paused' : ''}`}
      aria-label="Amplifier levels"
      title={
        paused
          ? 'Last status · updates paused during device operation'
          : 'Aggregate input/output peaks · dB · status reads only'
      }
    >
      {SLOTS.map((slot) => {
        const connection = connections[slot],
          metering = connection ? decodeMetering(connection.status) : undefined,
          name = slot === 'left' ? 'Left' : 'Right';
        return (
          <div
            key={slot}
            className="live-meter-amp"
            role="group"
            aria-label={`${name} amplifier levels`}
            title={
              connection
                ? `${name} · ${connection.identity.serial} · ${metering!.actualSampleRateHz ? `${metering!.actualSampleRateHz.toLocaleString()} Hz reported` : 'Sample rate unavailable'}${metering!.outputSuppressedByMute ? ' · master muted' : ''}`
                : `${name} · offline`
            }
          >
            <b>{slot === 'left' ? 'L' : 'R'}</b>
            {metering ? (
              <div className="live-meter-pair">
                <Peak name="Input" value={metering.inputPeakDb} />
                <Peak name="Output" value={metering.outputPeakDb} />
              </div>
            ) : (
              <span className="live-meter-offline">Offline</span>
            )}
          </div>
        );
      })}
    </section>
  );
}
