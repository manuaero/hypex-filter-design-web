import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebHidTransport } from '../src/hardware/transport';

function setup() {
  const hid = new EventTarget();
  vi.stubGlobal('navigator', { hid });
  const device = Object.assign(new EventTarget(), {
    opened: true,
    sendReport: vi.fn(async () => {}),
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
  return { transport, device, reply };
}

afterEach(() => vi.unstubAllGlobals());

describe('WebHID response diagnostics and fencing', () => {
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
