import { packet, type PanelStatus } from './codec';
import type { Identity, PanelSession } from './session';

export type NoiseIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export interface RotatingNoiseState {
  readonly requested: boolean | null;
  readonly acknowledgement: 'none' | 'accepted' | 'unconfirmed';
}
export interface NoiseResult {
  identity: NoiseIdentity;
  requested: boolean;
  acknowledged: true;
  /** The native action ACK is not an acoustic/noise-state readback. */
  actualState: 'unavailable';
  status?: PanelStatus;
  statusError?: string;
}
const unknown = Object.freeze({ requested: null, acknowledgement: 'none' } as const);
const requests = new WeakMap<PanelSession, Readonly<RotatingNoiseState>>();
export const getRotatingNoiseState = (session: PanelSession): Readonly<RotatingNoiseState> =>
  requests.get(session) ?? unknown;

function identity(value: NoiseIdentity): NoiseIdentity {
  if (
    !value ||
    typeof value.serial !== 'string' ||
    !value.serial ||
    value.product !== 22 ||
    value.core !== '5.1' ||
    typeof value.firmware !== 'string' ||
    !/^5\.\d+$/.test(value.firmware)
  )
    throw new Error('Rotating noise requires the recovered FA503 / DSP3-213 v5 identity');
  return Object.freeze({
    serial: value.serial,
    product: value.product,
    core: value.core,
    firmware: value.firmware,
  });
}
const matches = (a: NoiseIdentity, b: NoiseIdentity) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;

/** Read-only group preflight; no 08 action, control, flash or audio operation. */
export function preflightRotatingNoise(session: PanelSession): Promise<NoiseIdentity> {
  return session.exclusive(async () => {
    const current = identity(await session.identifyInternal());
    await session.statusInternal();
    return current;
  });
}

/** Main cbNoiseChange d059e0 → aaee30 → a9c668: 08/1e/bool.
 * aa9ba4..aa9c66 maps RAW command08 to internal message enum0e. The wire ACK
 * remains08 and byte1 must be1; 0e is NOT a USB command. Native callback has no
 * OEM-mask gate. We restrict the action to the independently identified FA503.
 * Native firmware owns rotation, configured outputs and the documented -55dB
 * test level. Do not synthesize audio or rewrite ordinary volume/mute settings.
 * This explicit action is never retried and never starts during construction.
 */
export function setRotatingNoise(
  session: PanelSession,
  enabled: boolean,
  expected?: NoiseIdentity,
): Promise<NoiseResult> {
  if (typeof enabled !== 'boolean')
    return Promise.reject(new Error('Noise requires an explicit boolean request'));
  let captured: NoiseIdentity | undefined;
  try {
    captured = expected === undefined ? undefined : identity(expected);
  } catch (error) {
    return Promise.reject(error);
  }
  return session.exclusive(async () => {
    const current = identity(await session.identifyInternal());
    if (captured && !matches(current, captured))
      throw new Error(
        'The amplifier identity changed before the noise request; no action was sent',
      );
    await session.statusInternal();
    try {
      const reply = await session.transport.exchange(packet(8, 0x1e, enabled ? 1 : 0));
      if (reply.length !== 64 || reply[0] !== 8 || reply[1] !== 1)
        throw new Error('The amplifier did not acknowledge the noise action');
    } catch (error) {
      requests.set(session, Object.freeze({ requested: enabled, acknowledgement: 'unconfirmed' }));
      throw new Error(
        `Noise ${enabled ? 'start' : 'stop'} is unconfirmed; do not assume its audible state. ${error instanceof Error ? error.message : 'USB request failed'}`,
      );
    }
    requests.set(session, Object.freeze({ requested: enabled, acknowledgement: 'accepted' }));
    const result: NoiseResult = {
      identity: current,
      requested: enabled,
      acknowledged: true,
      actualState: 'unavailable',
    };
    try {
      result.status = await session.statusInternal();
    } catch (error) {
      result.statusError = (
        error instanceof Error ? error.message : 'Status read failed after the noise ACK'
      ).slice(0, 512);
    }
    return result;
  });
}
