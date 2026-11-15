'use client';

import { useEffect, useState } from 'react';
import type { PanelStatus } from '../hardware/codec';
import type { Identity, PanelSession } from '../hardware/session';

export interface LiveEqTarget {
  session: PanelSession;
  identity: Identity;
  status: PanelStatus;
}

/** The native cbEqActiveChange affects the amp's active preset immediately.
 * The local design bypass is a separate, uploadable project property. */
export default function LiveEqToggle({
  live,
  role,
  busy,
  onChange,
}: {
  live?: LiveEqTarget;
  role: string;
  busy: boolean;
  onChange: (preset: number, enabled: boolean) => Promise<void>;
}) {
  const [access, setAccess] = useState<{
    session: PanelSession;
    serial: string;
    allowed: boolean;
    reason?: string;
  }>();
  useEffect(() => {
    let current = true;
    if (!live?.status.locked) return;
    const { session, identity } = live;
    setAccess(undefined);
    void session.protection().then(
      (report) => {
        if (!current) return;
        const allowed =
          report.identity.serial === identity.serial && report.operations.equalizer.allowed;
        setAccess({
          session,
          serial: identity.serial,
          allowed,
          reason: allowed
            ? undefined
            : (report.operations.equalizer.reason ?? 'Amplifier identity changed.'),
        });
      },
      () => {
        if (current)
          setAccess({
            session,
            serial: identity.serial,
            allowed: false,
            reason: 'EQ access could not be read. Refresh the amplifier connection.',
          });
      },
    );
    return () => {
      current = false;
    };
  }, [
    live?.session,
    live?.identity.serial,
    live?.status.locked,
    live?.status.raw[24],
    live?.status.raw[25],
    live?.status.raw[51],
  ]);
  const permission =
      access?.session === live?.session && access?.serial === live?.identity.serial
        ? access
        : undefined,
    allowed = !!live && (!live.status.locked || !!permission?.allowed),
    preset = live?.status.preset,
    enabled = !!live && !!(live.status.raw[11 + live.status.preset] & 16),
    title = !live
      ? `Connect the ${role} amplifier to change its live EQ bypass.`
      : !allowed
        ? (permission?.reason ?? 'Reading the amplifier’s EQ permission…')
        : `Immediately ${enabled ? 'bypass' : 'enable'} EQ on ${role} amp preset ${preset}. The staged design and filter flash stay unchanged.`;
  return (
    <label className="live-eq-toggle" title={title}>
      <input
        type="checkbox"
        aria-label={`${role} amplifier active preset EQ`}
        checked={enabled}
        disabled={busy || !allowed}
        onChange={(event) => {
          if (preset !== undefined) void onChange(preset, event.target.checked);
        }}
      />
      <span>
        {role} amp{preset ? ` P${preset}` : ''} EQ
      </span>
      <small>{live ? (enabled ? 'On' : 'Bypassed') : 'Offline'}</small>
    </label>
  );
}
