import {
  firmwarePacketAt,
  describeFirmwarePacketPlan,
  type FirmwareBundle,
} from '../domain/firmware';
import {
  createReferenceFirmwareChannel,
  type FirmwareBootloaderIdentity,
  type FirmwareExchangeContext,
  type FirmwareReferencePort,
} from './firmware-program';

export type FirmwareSimulationFault = {
  at: number;
  kind:
    | 'not-sent'
    | 'lost-ack'
    | 'reference-lost-ack'
    | 'stale-reply'
    | 'wrong-command'
    | 'disconnect'
    | 'exit-timeout';
  used?: boolean;
};
/** Reference test double, never a live USB transport. It validates packet order
 * without assigning unproved target erase/program/verify meanings to passes. */
export class SimulatedFirmwareBootloader {
  configuration = new Uint8Array(64);
  connectionId: string;
  connectionEpoch = 1;
  requests: { payload: Uint8Array; timeoutMs: number; requestId: string }[] = [];
  exchanges = 0;
  identityReads = 0;
  acceptedPackets = 0;
  exitRequested = false;
  fault?: FirmwareSimulationFault;
  statuses = new Map<number, number>();
  duplicatePolicy: 'reject' | 'accept-previous' = 'reject';
  /** Explicit reference recovery assumption, not target qualification. */
  restartOnHeader = false;
  beforeExchange?: (request: Uint8Array, context: FirmwareExchangeContext) => void | Promise<void>;
  afterWire?: (request: Uint8Array) => void;
  private pass: 0 | 1 = 0;
  private index = 0;
  private last?: Uint8Array;
  constructor(
    readonly bundle: FirmwareBundle,
    readonly serial = 'SIM-FIRMWARE-UNIT',
  ) {
    this.connectionId = `SIM-LOADER:${serial}`;
    this.configuration.set([6, 18, 99, 1, 3]);
    describeFirmwarePacketPlan(bundle);
  }
  identity(): FirmwareBootloaderIdentity {
    return {
      serial: this.serial,
      hidSerial: `SIMULATED-BOOTLOADER:${this.serial}`,
      family: this.bundle.family,
      connectionId: this.connectionId,
      connectionEpoch: this.connectionEpoch,
      configuration: this.configuration.slice(),
    };
  }
  /** Explicit reference recovery/re-enumeration, not a proved physical reset. */
  restartReference() {
    this.connectionEpoch++;
    this.pass = 0;
    this.index = 0;
    this.last = undefined;
    this.exitRequested = false;
  }
  channel() {
    let issuer!: ReturnType<typeof createReferenceFirmwareChannel>;
    const port: FirmwareReferencePort = {
      readBootloaderIdentity: async () => {
        this.identityReads++;
        return this.identity();
      },
      currentConnection: () => ({
        connectionId: this.connectionId,
        connectionEpoch: this.connectionEpoch,
      }),
      exchange: async (request, context) => {
        const at = this.exchanges++,
          fault = this.fault && !this.fault.used && this.fault.at === at ? this.fault : undefined;
        await this.beforeExchange?.(request.slice(), context);
        if (fault?.kind === 'not-sent') {
          fault.used = true;
          throw issuer.transportFailure('not-sent');
        }
        context.beforeWireSend();
        this.requests.push({
          payload: request.slice(),
          timeoutMs: context.timeoutMs,
          requestId: context.requestId,
        });
        this.afterWire?.(request.slice());
        const response = new Uint8Array(64);
        response[0] = request[0];
        if (request[0] === 0x40) {
          if (
            this.restartOnHeader &&
            (this.pass !== 0 || this.index !== 0) &&
            firmwarePacketAt(this.bundle, 0, 0).payload.every((n, i) => n === request[i])
          ) {
            this.pass = 0;
            this.index = 0;
            this.last = undefined;
          }
          const plan = describeFirmwarePacketPlan(this.bundle),
            previous = this.last && this.last.every((n, i) => n === request[i]);
          let valid = false;
          if (previous && this.duplicatePolicy === 'accept-previous') valid = true;
          else if (this.index < plan.packetsPerPass)
            valid = firmwarePacketAt(this.bundle, this.pass, this.index).payload.every(
              (n, i) => n === request[i],
            );
          response[1] = valid ? (this.statuses.get(this.acceptedPackets) ?? 0) : 0xf7;
          if (response[1] <= 1 && !(previous && this.duplicatePolicy === 'accept-previous')) {
            this.acceptedPackets++;
            this.last = request.slice();
            this.index++;
            if (this.index === plan.packetsPerPass && this.pass === 0) {
              this.pass = 1;
              this.index = 0;
            }
          }
        } else if (request[0] === 0x43) this.exitRequested = true;
        else throw new Error('Unsupported simulated firmware command');
        if (fault) {
          fault.used = true;
          if (fault.kind === 'lost-ack' || fault.kind === 'exit-timeout')
            throw new Error('Simulated ambiguous timeout; channel is not retry-qualified');
          if (fault.kind === 'reference-lost-ack') throw issuer.transportFailure('unconfirmed');
          if (fault.kind === 'disconnect') {
            this.connectionEpoch++;
            throw new Error('Simulated bootloader disconnect');
          }
          if (fault.kind === 'wrong-command') response[0] = 3;
        }
        return {
          connectionId: context.connectionId,
          connectionEpoch: context.connectionEpoch,
          requestId: fault?.kind === 'stale-reply' ? 'STALE-REQUEST' : context.requestId,
          reportId: 0,
          payload: response,
        };
      },
    };
    issuer = createReferenceFirmwareChannel(port);
    return issuer.channel;
  }
}
