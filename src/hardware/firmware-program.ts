import {
  describeFirmwarePacketPlan,
  firmwarePacketAt,
  parseFirmwareResponse,
  type FirmwareBundle,
  type FirmwareFamily,
} from '../domain/firmware';

export interface FirmwareConnectionStamp {
  connectionId: string;
  connectionEpoch: number;
}
export interface FirmwareBootloaderIdentity extends FirmwareConnectionStamp {
  /** Correlated physical-unit key from the discovery adapter, not a guessed B serial. */
  serial: string;
  hidSerial: string;
  family: FirmwareFamily;
  configuration: Uint8Array;
}
export interface FirmwareExchangeContext extends FirmwareConnectionStamp {
  requestId: string;
  timeoutMs: 4000 | 250;
  /** The adapter invokes this synchronously immediately before its actual send. */
  beforeWireSend(): void;
}
export interface FirmwareCorrelatedReply extends FirmwareConnectionStamp {
  requestId: string;
  reportId: number;
  payload: Uint8Array;
}
/** Injected reference/simulation only. No WebHID or production adapter is created here. */
export interface FirmwareReferencePort {
  readBootloaderIdentity(): Promise<FirmwareBootloaderIdentity>;
  currentConnection(): FirmwareConnectionStamp;
  exchange(request: Uint8Array, context: FirmwareExchangeContext): Promise<FirmwareCorrelatedReply>;
}
declare const channelBrand: unique symbol;
export interface FirmwareProgramChannel {
  readonly [channelBrand]: true;
}
type ChannelState = {
  port: FirmwareReferencePort;
  used: boolean;
  busy: boolean;
  poisoned: boolean;
  retryFailures: WeakMap<Error, 'not-sent' | 'unconfirmed'>;
};
const channels = new WeakMap<FirmwareProgramChannel, ChannelState>();
/** The retry issuer is local to this exact injected channel. A serialized flag,
 * a normal transport exception or another channel's error cannot grant retries.
 * No physical channel factory exists until loader correlation/replay is proved. */
export function createReferenceFirmwareChannel(port: FirmwareReferencePort) {
  if (
    !port ||
    !['readBootloaderIdentity', 'currentConnection', 'exchange'].every(
      (key) => typeof port[key as keyof FirmwareReferencePort] === 'function',
    )
  )
    throw new Error('Invalid injected firmware reference port');
  const channel = Object.freeze({}) as FirmwareProgramChannel,
    state: ChannelState = {
      port,
      used: false,
      busy: false,
      poisoned: false,
      retryFailures: new WeakMap(),
    };
  channels.set(channel, state);
  return Object.freeze({
    channel,
    transportFailure(
      delivery: 'not-sent' | 'unconfirmed',
      message = 'Injected native-reference transport failure',
    ) {
      if (!['not-sent', 'unconfirmed'].includes(delivery))
        throw new Error('Invalid reference failure disposition');
      const error = new Error(message.slice(0, 1024));
      state.retryFailures.set(error, delivery);
      return error;
    },
  });
}
export interface FirmwareProgramCursor {
  pass: 0 | 1;
  index: number;
}
export interface FirmwareProgramResult {
  qualifier: 'reference-simulation';
  outcome: 'stream-complete' | 'blocked' | 'rejected' | 'unconfirmed' | 'cancelled';
  serial: string;
  family: FirmwareFamily;
  streamComplete: boolean;
  recordsPerPass: number;
  packetsPerPass: number;
  acceptedPackets: number;
  acceptedRecords: number;
  nativeProgressRecords: number;
  nativeProgressMaximum: number;
  transportAttempts: number;
  wireRequests: number;
  lastAccepted?: FirmwareProgramCursor;
  targetStatus?: number;
  failureAt?: FirmwareProgramCursor;
  exit: {
    state: 'not-attempted' | 'acknowledged' | 'unconfirmed';
    attempted: boolean;
    error?: string;
  };
  error?: string;
}
export interface FirmwareProgramOptions {
  operationId: string;
  expected: Pick<
    FirmwareBootloaderIdentity,
    'serial' | 'family' | 'hidSerial' | 'connectionId' | 'connectionEpoch'
  >;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Verified durable intent must precede the first program send. */
  beforeFirstProgramRequest?(): Promise<void>;
  /** Synchronous assignment/cancellation fence; called immediately before a send. */
  assertCurrent?(): void;
  onWireSend?(cursor: FirmwareProgramCursor): void;
  onExitWireSend?(): void;
  onProgress?(result: Readonly<FirmwareProgramResult>): void;
  checkpointPass?(pass: 0 | 1, result: Readonly<FirmwareProgramResult>): Promise<void>;
  beforeExit?(): Promise<void>;
}
export class FirmwareProgramError extends Error {
  constructor(
    message: string,
    readonly result: Readonly<FirmwareProgramResult>,
  ) {
    super(message);
    this.name = 'FirmwareProgramError';
  }
}
const detail = (error: unknown) =>
  (error instanceof Error ? error.message : 'Firmware transport failed').slice(0, 1024);
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const copyResult = (result: FirmwareProgramResult) => frozen(structuredClone(result));
const sameStamp = (a: FirmwareConnectionStamp, b: FirmwareConnectionStamp) =>
  a.connectionId === b.connectionId && a.connectionEpoch === b.connectionEpoch;
function checkedIdentity(input: FirmwareBootloaderIdentity): FirmwareBootloaderIdentity {
  if (
    !input ||
    ![input.serial, input.hidSerial, input.connectionId].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\0-\x1f\x7f]/.test(v),
    ) ||
    !Number.isSafeInteger(input.connectionEpoch) ||
    input.connectionEpoch < 0 ||
    input.family !== 'FUSION32' ||
    !(input.configuration instanceof Uint8Array) ||
    input.configuration.length !== 64 ||
    input.configuration[0] !== 6 ||
    input.configuration[2] !== 99 ||
    !(
      (input.configuration[1] >= 0x10 && input.configuration[1] <= 0x1a) ||
      input.configuration[1] === 0x90
    )
  )
    throw new Error(
      'Firmware streaming requires a correlated FUSION32 bootloader reporting06 major99',
    );
  return { ...input, configuration: input.configuration.slice() };
}
function checkedReply(
  reply: FirmwareCorrelatedReply,
  context: FirmwareExchangeContext,
  command: number,
): Uint8Array {
  if (
    !reply ||
    reply.reportId !== 0 ||
    reply.requestId !== context.requestId ||
    !sameStamp(reply, context) ||
    !(reply.payload instanceof Uint8Array) ||
    reply.payload.length !== 64 ||
    reply.payload[0] !== command
  )
    throw new Error('Firmware reply correlation failed; the channel cannot be reused');
  return reply.payload.slice();
}

/** Source-exact native pass ordering, pairing and status handling. No entry40,
 * cancel41, normal-HID relaxation, erase/readback invention or automatic retry
 * after an ordinary/poisoned transport failure. Cancellation is a browser host
 * stop after the current response, not a claim that target41 rolls anything back. */
export async function programNativeFirmware(
  bundle: FirmwareBundle,
  channel: FirmwareProgramChannel,
  options: FirmwareProgramOptions,
): Promise<Readonly<FirmwareProgramResult>> {
  const state = channels.get(channel),
    plan = describeFirmwarePacketPlan(bundle);
  if (!state || state.busy || state.used || state.poisoned)
    throw new Error('Firmware channel is unknown, consumed, busy or poisoned');
  if (
    bundle.family !== 'FUSION32' ||
    !options ||
    typeof options.operationId !== 'string' ||
    !/^[^\0-\x1f\x7f]{1,160}$/.test(options.operationId)
  )
    throw new Error(
      'Firmware programmer requires the recovered FUSION32 profile and an operation identity',
    );
  state.busy = true;
  const wait =
      options.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    result: FirmwareProgramResult = {
      qualifier: 'reference-simulation',
      outcome: 'blocked',
      serial: '',
      family: bundle.family,
      streamComplete: false,
      recordsPerPass: plan.recordsPerPass,
      packetsPerPass: plan.packetsPerPass,
      acceptedPackets: 0,
      acceptedRecords: 0,
      nativeProgressRecords: 0,
      nativeProgressMaximum: plan.totalRecords,
      transportAttempts: 0,
      wireRequests: 0,
      exit: { state: 'not-attempted', attempted: false },
    };
  const expected = { ...options.expected };
  let identity: FirmwareBootloaderIdentity | undefined,
    prepared = false;
  const progress = () => {
    try {
      options.onProgress?.(copyResult(result));
    } catch {
      /* A view observer cannot interrupt a wire operation. */
    }
  };
  const current = () => {
    if (!identity || state.poisoned || !sameStamp(identity, state.port.currentConnection()))
      throw new Error('Firmware bootloader connection changed');
    options.assertCurrent?.();
  };
  const fail = (outcome: FirmwareProgramResult['outcome'], error: unknown): never => {
    result.outcome = outcome;
    result.error = detail(error);
    progress();
    throw new FirmwareProgramError(result.error, copyResult(result));
  };
  try {
    options.signal?.throwIfAborted();
    identity = checkedIdentity(await state.port.readBootloaderIdentity());
    result.serial = identity.serial;
    if (
      identity.family !== bundle.family ||
      identity.serial !== expected.serial ||
      identity.hidSerial !== expected.hidSerial ||
      !sameStamp(identity, expected) ||
      expected.family !== identity.family
    )
      fail('blocked', new Error('Firmware family differs from the correlated bootloader'));
    current();
    for (const pass of [0, 1] as const) {
      for (let index = 0; index < plan.packetsPerPass; index++) {
        const cursor = { pass, index },
          packet = firmwarePacketAt(bundle, pass, index);
        result.failureAt = cursor;
        if (options.signal?.aborted)
          fail(
            'cancelled',
            new Error(
              'Firmware host stopped before the next packet; target rollback is unverified',
            ),
          );
        current();
        if (!prepared) {
          await options.beforeFirstProgramRequest?.();
          prepared = true;
        }
        let accepted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          current();
          if (options.signal?.aborted)
            fail('cancelled', new Error('Firmware host stopped before a packet retry'));
          let sent = false;
          const context: FirmwareExchangeContext = {
            connectionId: identity.connectionId,
            connectionEpoch: identity.connectionEpoch,
            requestId: `${options.operationId}:${pass}:${index}:${attempt}`,
            timeoutMs: 4000,
            beforeWireSend() {
              if (sent) throw new Error('Firmware adapter repeated its wire-send admission');
              current();
              options.signal?.throwIfAborted();
              options.onWireSend?.(cursor);
              state.used = true;
              sent = true;
              result.wireRequests++;
            },
          };
          result.transportAttempts++;
          let reply: FirmwareCorrelatedReply;
          try {
            reply = await state.port.exchange(packet.payload.slice(), context);
          } catch (error) {
            if (options.signal?.aborted && !sent) fail('cancelled', error);
            const referenceFailure =
              error instanceof Error ? state.retryFailures.get(error) : undefined;
            if (referenceFailure && !(referenceFailure === 'not-sent' && sent)) {
              // a9ad58 sleeps after all3 failures, including its final failure.
              await wait((attempt + 1) * 100);
              if (attempt < 2) continue;
              if (referenceFailure === 'unconfirmed') state.poisoned = true;
              fail(
                referenceFailure === 'not-sent' && result.wireRequests === 0
                  ? 'blocked'
                  : 'unconfirmed',
                error,
              );
            }
            state.poisoned = true;
            fail('unconfirmed', error);
          }
          let payload: Uint8Array;
          try {
            current();
            if (!sent)
              throw new Error('Firmware adapter returned a reply without a wire-send event');
            payload = checkedReply(reply!, context, 0x40);
          } catch (error) {
            state.poisoned = true;
            fail('unconfirmed', error);
          }
          const response = parseFirmwareResponse(payload!);
          result.targetStatus = response.statusCode;
          if (response.kind === 'error') fail('rejected', new Error(response.message));
          // Native status1 is accepted, but never substitutes for file EOF.
          accepted = true;
          result.acceptedPackets++;
          result.acceptedRecords += packet.recordCount;
          result.nativeProgressRecords += 2;
          result.lastAccepted = cursor;
          progress();
          break;
        }
        if (!accepted) fail('unconfirmed', new Error('Firmware packet was not accepted'));
      }
      await options.checkpointPass?.(pass, copyResult(result));
    }
    delete result.failureAt;
    result.streamComplete = true;
    if (options.signal?.aborted)
      fail('cancelled', new Error('Firmware passes finished; host stopped before exit43'));
    await options.beforeExit?.();
    current();
    const request = new Uint8Array(64);
    request[0] = 0x43;
    const context: FirmwareExchangeContext = {
      connectionId: identity.connectionId,
      connectionEpoch: identity.connectionEpoch,
      requestId: `${options.operationId}:exit`,
      timeoutMs: 250,
      beforeWireSend() {
        current();
        options.signal?.throwIfAborted();
        options.onExitWireSend?.();
        result.exit.attempted = true;
      },
    };
    try {
      const reply = await state.port.exchange(request, context);
      if (!result.exit.attempted) throw new Error('Exit reply without a wire-send event');
      checkedReply(reply, context, 0x43);
      result.exit.state = 'acknowledged';
    } catch (error) {
      result.exit.state = 'unconfirmed';
      result.exit.error = detail(error);
      state.poisoned = true;
    }
    // Native leaves pass success true after exit failure. Expose that separate
    // fact; only the discovery coordinator can prove a fresh runtime identity.
    result.outcome = 'stream-complete';
    progress();
    return copyResult(result);
  } catch (error) {
    if (error instanceof FirmwareProgramError) throw error;
    return fail(
      options.signal?.aborted ? 'cancelled' : result.wireRequests ? 'unconfirmed' : 'blocked',
      error,
    );
  } finally {
    state.busy = false;
  }
}
