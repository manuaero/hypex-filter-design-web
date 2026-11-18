import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebHidTransport } from '../src/hardware/transport';

function setup() {
  const hid = new EventTarget();
  vi.stubGlobal('navigator', { hid });
  const device = Object.assign(new EventTarget(), {
    opened: true,
    sendReport: vi.fn(async (_reportId: number, _data: BufferSource) => {}),
    close: vi.fn(async () => {}),
  });
  const transport = new WebHidTransport(device as unknown as HIDDevice);
  const reply = (bytes: Uint8Array, reportId = 0) => {
    const event = new Event('inputreport');
    Object.assign(event, {
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      reportId,
    });
    device.dispatchEvent(event);
  };
  return { transport, device, reply, hid };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const frame = (command: number) => Uint8Array.of(command, ...Array(63).fill(0));
const queued = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('WebHID response diagnostics and fencing', () => {
  it('keeps status telemetry separate from a pending runtime identity read', async () => {
    const { transport, device, reply } = setup();
    const request = frame(6);
    request[1] = 1;
    const result = transport.exchange(request), settled = vi.fn();
    void result.then(settled);
    await queued();
    reply(frame(5));
    await queued();
    expect(settled).not.toHaveBeenCalled();
    reply(frame(6));
    expect(await result).toEqual(frame(6));
    expect(device.sendReport).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  it('does not extend a runtime read timeout when status notifications arrive', async () => {
    vi.useFakeTimers();
    const { transport, reply } = setup();
    const request = frame(0x66);
    const result = transport.exchange(request, 100);
    const assertion = expect(result).rejects.toThrow(/timed out/);
    await queued();
    await vi.advanceTimersByTimeAsync(90);
    reply(frame(5));
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    await transport.close();
  });

  it.each([[3, 0], [0x66, 1], [0x40, 0]])('still rejects status as a reply to setter/firmware %s/%s', async (opcode, mode) => {
    const { transport, reply } = setup();
    const request = frame(opcode);
    request[1] = mode;
    const result = transport.exchange(request);
    const assertion = expect(result).rejects.toThrow(/Unexpected HID reply/);
    await queued();
    reply(frame(5));
    await assertion;
    await transport.close();
  });

  it.each([0, 1])('does not confuse a delayed status mode %s notification with the next identity reply', async (mode) => {
    const { transport, device, reply } = setup();
    const request = frame(5);
    request[1] = mode;
    const setter = transport.exchange(request);
    const identity = frame(6);
    identity[1] = 1;
    const read = transport.exchange(identity), settled = vi.fn();
    void read.then(settled);
    await queued();
    reply(frame(5));
    await setter;
    await queued();
    expect(device.sendReport).toHaveBeenCalledTimes(2);
    reply(frame(5));
    await queued();
    expect(settled).not.toHaveBeenCalled();
    reply(frame(6));
    expect(await read).toEqual(frame(6));
    await transport.close();
  });

  it('accepts a matching sliced 64-byte report', async () => {
    const { transport, reply } = setup();
    const request = new Uint8Array(64);
    request[0] = 6;
    const result = transport.exchange(request);
    await Promise.resolve();
    const storage = new Uint8Array(70);
    storage[3] = 6;
    reply(storage.subarray(3, 67));
    expect(await result).toEqual(request);
    await transport.close();
  });

  it.each([
    { opcode: 5, reportId: 0, length: 64, received: '0x05' },
    { opcode: 6, reportId: 1, length: 64, received: '0x06' },
    { opcode: 6, reportId: 0, length: 65, received: '0x06' },
    { opcode: 6, reportId: 0, length: 0, received: 'missing' },
  ])(
    'reports only frame metadata and poisons a mismatch: $reportId/$length/$received',
    async (test) => {
      const { transport, device, reply } = setup();
      const request = new Uint8Array(64);
      request[0] = 6;
      const result = transport.exchange(request);
      const queued = transport.exchange(request);
      const expected = `Unexpected HID reply (expected 0x06, received ${test.received}, report ${test.reportId}, ${test.length} bytes); close other controllers and reconnect`;
      const assertion = expect(result).rejects.toThrow(expected);
      const queuedAssertion = expect(queued).rejects.toThrow(expected);
      await Promise.resolve();
      const bytes = new Uint8Array(test.length).fill(0x73);
      if (bytes.length) bytes[0] = test.opcode;
      reply(bytes, test.reportId);
      await assertion;
      await queuedAssertion;
      // A later matching report cannot revive this physical session.
      reply(request);
      await expect(transport.exchange(request)).rejects.toThrow(expected);
      expect(device.sendReport).toHaveBeenCalledTimes(1);
      await transport.close();
      expect(device.close).toHaveBeenCalledOnce();
    },
  );
});

describe('WebHID firmware wire boundaries', () => {
  it.each([0, -1, NaN, Infinity, 1.25, 0x80000000])(
    'refuses an invalid fenced timeout%s without sending or invoking the fence',
    async (timeout) => {
      const { transport, device } = setup(),
        fence = vi.fn();
      await expect(transport.exchangeWithFence(frame(0x40), timeout, fence)).rejects.toThrow(
        /timeout/i,
      );
      expect(fence).not.toHaveBeenCalled();
      expect(device.sendReport).not.toHaveBeenCalled();
      await transport.close();
    },
  );

  it('runs the stream fence inside the physical queue immediately before send', async () => {
    const { transport, device, reply } = setup(),
      calls: number[] = [];
    const ordinary = transport.exchange(frame(6));
    const streamed = transport.exchangeWithFence(frame(0x40), 4000, () => {
      calls.push(device.sendReport.mock.calls.length);
    });
    await queued();
    expect(device.sendReport).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    reply(frame(6));
    await ordinary;
    await queued();
    expect(calls).toEqual([1]);
    expect(device.sendReport).toHaveBeenCalledTimes(2);
    reply(frame(0x40));
    expect(await streamed).toEqual(frame(0x40));
    await transport.close();
  });

  it('does not send or poison when a queued stream fence refuses', async () => {
    const { transport, device, reply } = setup();
    await expect(
      transport.exchangeWithFence(frame(0x40), 4000, () => {
        throw Error('Assignment changed');
      }),
    ).rejects.toThrow('Assignment changed');
    expect(device.sendReport).not.toHaveBeenCalled();
    const ordinary = transport.exchange(frame(6));
    await queued();
    reply(frame(6));
    expect(await ordinary).toEqual(frame(6));
    await transport.close();
  });

  it('sends an isolated stream packet even if its caller-owned buffer changes in the fence', async () => {
    const { transport, device, reply } = setup(),
      request = frame(0x40);
    const streamed = transport.exchangeWithFence(request, 4000, () => {
      request[0] = 6;
    });
    await queued();
    expect(new Uint8Array(device.sendReport.mock.calls[0][1] as ArrayBuffer)).toEqual(frame(0x40));
    reply(frame(0x40));
    expect(await streamed).toEqual(frame(0x40));
    await transport.close();
  });

  it('queues one entry send after an ordinary request and retires the old transport first', async () => {
    const { transport, device, reply, hid } = setup(),
      removeInput = vi.spyOn(device, 'removeEventListener'),
      removeDisconnect = vi.spyOn(hid, 'removeEventListener'),
      fence = vi.fn(() => {
        expect(device.sendReport).toHaveBeenCalledTimes(1);
      });
    const ordinary = transport.exchange(frame(6));
    const entry = transport.transitionToBootloader(frame(0x40), fence);
    await queued();
    expect(fence).not.toHaveBeenCalled();
    reply(frame(6));
    await ordinary;
    expect(await entry).toBe('sent');
    expect(fence).toHaveBeenCalledOnce();
    expect(removeInput).toHaveBeenCalledWith('inputreport', expect.any(Function));
    expect(removeDisconnect).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(device.sendReport).toHaveBeenCalledTimes(2);
    // Neither a stale configuration frame nor a matching40 can revive the retired epoch.
    reply(frame(6));
    reply(frame(0x40));
    await expect(transport.exchange(frame(6))).rejects.toThrow(/retired.*firmware/i);
    await expect(transport.transitionToBootloader(frame(0x40), vi.fn())).rejects.toThrow(
      /retired.*firmware/i,
    );
    expect(device.sendReport).toHaveBeenCalledTimes(2);
    await transport.close();
  });

  it('does not interpret a matching report as an entry acknowledgement', async () => {
    vi.useFakeTimers();
    const { transport, device, reply } = setup();
    device.sendReport.mockImplementation(() => new Promise<void>(() => {}));
    const entry = transport.transitionToBootloader(frame(0x40), () => {}),
      settled = vi.fn();
    void entry.then(settled);
    await queued();
    reply(frame(0x40));
    reply(frame(6));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await entry).toBe('unconfirmed');
    expect(device.sendReport).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('keeps entry unconfirmed after a late host-send resolution and never retries', async () => {
    vi.useFakeTimers();
    const { transport, device } = setup();
    let complete!: () => void;
    device.sendReport.mockImplementation(
      () => new Promise<void>((resolve) => (complete = resolve)),
    );
    const entry = transport.transitionToBootloader(frame(0x40), () => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(await entry).toBe('unconfirmed');
    complete();
    await queued();
    expect(await entry).toBe('unconfirmed');
    await expect(transport.exchange(frame(6))).rejects.toThrow(/retired.*firmware/i);
    expect(device.sendReport).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('treats host-send rejection as unconfirmed and consumes entry', async () => {
    const { transport, device } = setup();
    device.sendReport.mockRejectedValue(new Error('Disconnected during send'));
    expect(await transport.transitionToBootloader(frame(0x40), () => {})).toBe('unconfirmed');
    await expect(transport.transitionToBootloader(frame(0x40), vi.fn())).rejects.toThrow(
      /retired.*firmware/i,
    );
    expect(device.sendReport).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('consumes entry after a synchronous host-send exception without retrying', async () => {
    const { transport, device } = setup();
    device.sendReport.mockImplementation(() => {
      throw Error('Host send failed');
    });
    expect(await transport.transitionToBootloader(frame(0x40), () => {})).toBe('unconfirmed');
    await expect(transport.exchange(frame(6))).rejects.toThrow(/retired.*firmware/i);
    expect(device.sendReport).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('poisons an ordinary request after a synchronous send exception', async () => {
    const { transport, device } = setup();
    device.sendReport.mockImplementation(() => {
      throw Error('Synchronous delivery failure');
    });
    await expect(transport.exchange(frame(6))).rejects.toThrow('Synchronous delivery failure');
    await expect(transport.exchange(frame(6))).rejects.toThrow('Synchronous delivery failure');
    expect(device.sendReport).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('does not run an entry fence for a closed interface', async () => {
    const { transport, device } = setup(),
      fence = vi.fn();
    device.opened = false;
    await expect(transport.transitionToBootloader(frame(0x40), fence)).rejects.toThrow(/closed/i);
    expect(fence).not.toHaveBeenCalled();
    expect(device.sendReport).not.toHaveBeenCalled();
    await transport.close();
  });

  it.each(['entry', 'stream'] as const)(
    'refuses an async%s fence before any send and keeps the transport usable',
    async (operation) => {
      const { transport, device, reply } = setup();
      const fence = async () => {
        await Promise.resolve();
        throw Error('Late refusal');
      };
      await expect(
        operation === 'entry'
          ? transport.transitionToBootloader(frame(0x40), fence)
          : transport.exchangeWithFence(frame(0x40), 4000, fence),
      ).rejects.toThrow('synchronously');
      await queued();
      expect(device.sendReport).not.toHaveBeenCalled();
      const ordinary = transport.exchange(frame(6));
      await queued();
      reply(frame(6));
      expect(await ordinary).toEqual(frame(6));
      await transport.close();
    },
  );

  it('leaves entry unattempted and the ordinary transport usable when its final fence refuses', async () => {
    const { transport, device, reply } = setup();
    await expect(
      transport.transitionToBootloader(frame(0x40), () => {
        throw Error('Role changed');
      }),
    ).rejects.toThrow('Role changed');
    expect(device.sendReport).not.toHaveBeenCalled();
    const ordinary = transport.exchange(frame(6));
    await queued();
    reply(frame(6));
    expect(await ordinary).toEqual(frame(6));
    await transport.close();
  });

  it.each([frame(0x43), Uint8Array.of(0x40), Uint8Array.of(0x40, 1, ...Array(62).fill(0))])(
    'refuses any entry shape except the fixed64-byte40/00 frame before invoking its fence',
    async (request) => {
      const { transport, device } = setup(),
        fence = vi.fn();
      await expect(transport.transitionToBootloader(request, fence)).rejects.toThrow(/entry/i);
      expect(fence).not.toHaveBeenCalled();
      expect(device.sendReport).not.toHaveBeenCalled();
      await transport.close();
    },
  );
});
