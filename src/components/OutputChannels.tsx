import { Volume2, VolumeX } from 'lucide-react';
import type { Channel, Slot } from '../domain/model';
import styles from './OutputChannels.module.css';

export default function OutputChannels({
  channels,
  colors,
  selected,
  slot,
  channelMutes,
  masterMuted,
  busy,
  onSelect,
  onLiveMute,
}: {
  channels: readonly Channel[];
  colors: readonly string[];
  selected: number;
  slot: Slot;
  channelMutes?: readonly boolean[];
  masterMuted?: boolean;
  busy: boolean;
  onSelect(index: number): void;
  onLiveMute(index: number, muted: boolean): void;
}) {
  const role = slot === 'left' ? 'Left' : 'Right';
  return (
    <section className={styles.overview} aria-label={`${role} output controls`}>
      <div className={styles.heading}>
        <span>OUTPUTS · {role.toUpperCase()}</span>
        <span>LIVE MUTE</span>
      </div>
      <div className={styles.rows}>
        <div className={`channel-list ${styles.selectors}`}>
          {channels.map((channel, index) => (
            <button
              key={channel.id}
              style={{ '--channel-color': colors[index] } as React.CSSProperties}
              className={selected === index ? 'active' : ''}
              aria-label={`Edit output CH${index + 1} · ${channel.name}`}
              aria-pressed={selected === index}
              title={`CH${index + 1} · ${channel.name} · Design gain ${channel.gain.toFixed(2)} dB${channel.muted ? ' · Preview muted' : ''}`}
              onClick={() => onSelect(index)}
            >
              <span className="channel-number">0{index + 1}</span>
              <div className={styles.identity}>
                <strong>{channel.name}</strong>
                <small>
                  {channel.gain.toFixed(2)} dB
                  {channel.muted ? ' · preview muted' : ''}
                </small>
              </div>
            </button>
          ))}
        </div>
        <div className={styles.mutes}>
          {channels.map((channel, index) => {
            const muted = channelMutes?.[index];
            const available = typeof muted === 'boolean';
            return (
              <button
                key={channel.id}
                className={muted ? styles.muted : ''}
                aria-label={`Live output mute CH${index + 1}`}
                aria-pressed={available ? muted : undefined}
                disabled={!available || busy}
                title={
                  available
                    ? `${muted ? 'Unmute' : 'Mute'} ${role} amplifier output CH${index + 1} immediately. Other outputs and the other amplifier stay unchanged.`
                    : `Connect the ${role} amplifier to mute output CH${index + 1}.`
                }
                onClick={() => {
                  if (available) onLiveMute(index, !muted);
                }}
              >
                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                <span>{available ? (muted ? 'Muted' : 'Mute') : 'Offline'}</span>
              </button>
            );
          })}
        </div>
      </div>
      <p className={styles.status}>
        {channelMutes
          ? masterMuted
            ? 'Master muted · output states shown above'
            : 'Live mutes apply immediately'
          : 'USB offline · live mutes unavailable'}
      </p>
    </section>
  );
}
