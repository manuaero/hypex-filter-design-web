export interface Transport {
  exchange(payload: Uint8Array, timeout?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
/** Host send settlement only. Native40 entry can return stale TX data, so this
 * timeout is never a target acknowledgement or evidence of loader identity. */
export const FIRMWARE_ENTRY_SEND_TIMEOUT_MS = 5000;
function runWireFence(fence: () => void) {
  const returned = (fence as () => unknown)();
  if (
    returned !== null &&
    (typeof returned === 'object' || typeof returned === 'function') &&
    typeof (returned as { then?: unknown }).then === 'function'
  ) {
    // A mistakenly async callback must not authorize a send before it settles.
    // Observe its eventual rejection while refusing this unattempted request.
    void Promise.resolve(returned).catch(() => {});
    throw new Error('The HID wire fence must finish synchronously');
  }
}
export class AsyncQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => {});
    return next;
  }
}
/** Exactly one pending request on each physical HID interface. Timeout poisons
 * the transport so a delayed same-command reply cannot satisfy the next request. */
export class WebHidTransport implements Transport {
  private queue = new AsyncQueue();
  private pending?: {
    command: number;
    allowStatusNotification: boolean;
    resolve: (b: Uint8Array) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private fault?: Error;
  constructor(readonly device: HIDDevice) {
    device.addEventListener('inputreport', this.receive);
    navigator.hid.addEventListener('disconnect', this.disconnect);
  }
  private disconnect = (event: HIDConnectionEvent) => {
    if (event.device === this.device) {
      this.fail(new Error('USB disconnected'));
    }
  };
  private fail(error: Error) {
    this.fault = error;
    const p = this.pending;
    if (p) {
      clearTimeout(p.timer);
      this.pending = undefined;
      p.reject(error);
    }
  }
  private receive = (event: HIDInputReportEvent) => {
    const p = this.pending;
    if (!p) return;
    const b = new Uint8Array(
      event.data.buffer,
      event.data.byteOffset,
      event.data.byteLength,
    ).slice();
    // Runtime FA503s also publish 05 telemetry while a read is outstanding.
    // It is not an acknowledgement of that read: retain its original timer
    // and wait for its own opcode. Admit this only for known runtime reads,
    // never setters, stream/loader requests, malformed frames or other opcodes.
    if (event.reportId === 0 && b.length === 64 && b[0] === 5 && p.allowStatusNotification)
      return;
    if (event.reportId !== 0 || b.length !== 64 || b[0] !== p.command) {
      const opcode = (value: number | undefined) =>
        value === undefined ? 'missing' : `0x${value.toString(16).padStart(2, '0')}`;
      this.fail(
        new Error(
          `Unexpected HID reply (expected ${opcode(p.command)}, received ${opcode(b[0])}, report ${event.reportId}, ${b.length} bytes); close other controllers and reconnect`,
        ),
      );
      return;
    }
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve(b);
  };
  exchange(payload: Uint8Array, timeout = 1200): Promise<Uint8Array> {
    return this.exchangeQueued(payload, timeout);
  }
  /** A final synchronous assignment/epoch fence inside this interface's queue.
   * Request IDs are local routing metadata; unsequenced target replies still
   * require an independently qualified physical delivery profile. */
  exchangeWithFence(
    payload: Uint8Array,
    timeout: number,
    beforeWireSend: () => void,
  ): Promise<Uint8Array> {
    if (
      typeof beforeWireSend !== 'function' ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > 0x7fffffff
    )
      return Promise.reject(new Error('A synchronous HID send fence and timeout are required'));
    return this.exchangeQueued(payload, timeout, beforeWireSend);
  }
  private exchangeQueued(
    payload: Uint8Array,
    timeout: number,
    beforeWireSend?: () => void,
  ): Promise<Uint8Array> {
    return this.queue.run(async () => {
      if (this.fault) throw this.fault;
      if (!this.device.opened || payload.length !== 64)
        throw new Error('HID device is closed or packet size invalid');
      const request = new Uint8Array(payload);
      // There is no await between this callback and sendReport. A refusal has
      // no pending request/timer and does not poison an unattempted transport.
      if (beforeWireSend) runWireFence(beforeWireSend);
      const reply = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(
          () => this.fail(new Error('USB reply timed out; reconnect before continuing')),
          timeout,
        );
        const allowStatusNotification =
          !beforeWireSend && ((request[0] === 6 && request[1] === 1) ||
          (request[0] === 3 && request[1] === 8) ||
          ((request[0] === 0x66 || request[0] === 0x67) && request[1] === 0) ||
          (request[0] === 0x65 && request[1] >= 1 && request[1] <= 60));
        this.pending = { command: request[0], allowStatusNotification, resolve, reject, timer };
        try {
          this.device.sendReport(0, request).catch((e) => this.fail(new Error(String(e))));
        } catch (error) {
          this.fail(new Error(String(error)));
        }
      });
      return reply;
    });
  }
  /** Fixed runtime40/00 transition, not an ordinary request/reply exchange.
   * This method does not grant firmware qualification or discover a loader.
   * A qualified owner must reserve the session and supply the final wire fence.
   * The old epoch is retired before exactly one host send; no automatic retry. */
  transitionToBootloader(
    payload: Uint8Array,
    beforeWireSend: () => void,
  ): Promise<'sent' | 'unconfirmed'> {
    const request = new Uint8Array(payload);
    return this.queue.run(async () => {
      if (this.fault) throw this.fault;
      if (
        request.length !== 64 ||
        request[0] !== 0x40 ||
        request.subarray(1).some((byte) => byte !== 0) ||
        typeof beforeWireSend !== 'function'
      )
        throw new Error('Firmware entry requires the fixed64-byte40/00 frame and wire fence');
      if (!this.device.opened) throw new Error('HID device is closed before firmware entry');
      runWireFence(beforeWireSend);
      this.fail(
        new Error(
          'Runtime USB connection retired for firmware transition; reconnect before continuing',
        ),
      );
      this.removeListeners();
      return new Promise<'sent' | 'unconfirmed'>((resolve) => {
        let settled = false;
        const finish = (outcome: 'sent' | 'unconfirmed') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const timer = setTimeout(() => finish('unconfirmed'), FIRMWARE_ENTRY_SEND_TIMEOUT_MS);
        try {
          // A fulfilled host promise is not proof of a target ACK or transition.
          this.device.sendReport(0, request).then(
            () => finish('sent'),
            () => finish('unconfirmed'),
          );
        } catch {
          finish('unconfirmed');
        }
      });
    });
  }
  private removeListeners() {
    this.device.removeEventListener('inputreport', this.receive);
    navigator.hid.removeEventListener('disconnect', this.disconnect);
  }
  async close() {
    this.fail(new Error('USB session closed'));
    this.removeListeners();
    if (this.device.opened) await this.device.close();
  }
}
