export interface Transport {
  exchange(payload: Uint8Array, timeout?: number): Promise<Uint8Array>;
  close(): Promise<void>;
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
    return this.queue.run(async () => {
      if (this.fault) throw this.fault;
      if (!this.device.opened || payload.length !== 64)
        throw new Error('HID device is closed or packet size invalid');
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(
          () => this.fail(new Error('USB reply timed out; reconnect before continuing')),
          timeout,
        );
        this.pending = { command: payload[0], resolve, reject, timer };
        this.device
          .sendReport(0, new Uint8Array(payload))
          .catch((e) => this.fail(new Error(String(e))));
      });
    });
  }
  async close() {
    this.fail(new Error('USB session closed'));
    this.device.removeEventListener('inputreport', this.receive);
    navigator.hid.removeEventListener('disconnect', this.disconnect);
    if (this.device.opened) await this.device.close();
  }
}
