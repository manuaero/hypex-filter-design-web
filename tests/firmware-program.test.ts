import { expect, it } from 'vitest';
import { parseFirmwareBundle, firmwarePacketAt } from '../src/domain/firmware';
import {
  programNativeFirmware,
  FirmwareProgramError,
  createReferenceFirmwareChannel,
  type FirmwareProgramChannel,
} from '../src/hardware/firmware-program';
import { SimulatedFirmwareBootloader } from '../src/hardware/firmware-simulator';
const source = [
  ':10000080A80D0000CA080000465553494F4E3332B0',
  ':01000081027C',
  ':020000040000FA',
  ':10068000464133320000000000000000000000007E',
  ':00000001FF',
].join('\n');
const bundle = parseFirmwareBundle(source, 'Literal native-profile fixture');
const options = (panel: SimulatedFirmwareBootloader) => ({
  operationId: 'reference-test',
  expected: panel.identity(),
  sleep: async () => {},
});

it('streams both complete original passes, odd EOF and exact timeouts without assigning target pass meanings', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle),
    channel = panel.channel(),
    before = JSON.stringify(bundle),
    order: string[] = [];
  panel.beforeExchange = (request) => {
    if (request[0] === 0x40) expect(order).toContain('durable-intent');
  };
  const result = await programNativeFirmware(bundle, channel, {
    ...options(panel),
    beforeFirstProgramRequest: async () => {
      order.push('durable-intent');
    },
    checkpointPass: async (pass) => {
      order.push(`pass${pass}`);
    },
    beforeExit: async () => {
      order.push('exit-intent');
    },
  });
  expect(result).toMatchObject({
    outcome: 'stream-complete',
    qualifier: 'reference-simulation',
    streamComplete: true,
    acceptedPackets: 6,
    acceptedRecords: 10,
    nativeProgressRecords: 12,
    nativeProgressMaximum: 10,
    transportAttempts: 6,
    wireRequests: 6,
    exit: { attempted: true, state: 'acknowledged' },
  });
  expect(panel.requests.slice(0, 6).map((r) => Array.from(r.payload))).toEqual(
    ([0, 1] as const).flatMap((pass) =>
      [0, 1, 2].map((index) => Array.from(firmwarePacketAt(bundle, pass, index).payload)),
    ),
  );
  expect(panel.requests.map((r) => r.timeoutMs)).toEqual([4000, 4000, 4000, 4000, 4000, 4000, 250]);
  expect(panel.requests.at(-1)!.payload[0]).toBe(0x43);
  expect(order).toEqual(['durable-intent', 'pass0', 'pass1', 'exit-intent']);
  expect(JSON.stringify(bundle)).toBe(before);
  await expect(programNativeFirmware(bundle, channel, options(panel))).rejects.toThrow('consumed');
});

it('treats status1 as accepted but follows file EOF rather than stopping at an early EOF status', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle);
  panel.statuses.set(0, 1);
  const result = await programNativeFirmware(bundle, panel.channel(), options(panel));
  expect(result.acceptedPackets).toBe(6);
  expect(panel.requests).toHaveLength(7);
});

it.each([0x9d, 0x9e, 0xf6, 0xf7, 0xfb, 0xff, 7])(
  'preserves confirmed target rejection0x%s without retry or exit',
  async (code) => {
    const panel = new SimulatedFirmwareBootloader(bundle);
    panel.statuses.set(1, code);
    await expect(
      programNativeFirmware(bundle, panel.channel(), options(panel)),
    ).rejects.toMatchObject({
      result: {
        outcome: 'rejected',
        acceptedPackets: 1,
        acceptedRecords: 2,
        transportAttempts: 2,
        wireRequests: 2,
        targetStatus: code,
        exit: { state: 'not-attempted' },
      },
    });
    expect(panel.requests).toHaveLength(2);
    expect(panel.exitRequested).toBe(false);
  },
);

it('models native3 total transport attempts and100/200/300 waits only for channel-issued reference failures', async () => {
  let calls = 0;
  const delays: number[] = [],
    identity = new SimulatedFirmwareBootloader(bundle).identity();
  let reference!: ReturnType<typeof createReferenceFirmwareChannel>;
  reference = createReferenceFirmwareChannel({
    readBootloaderIdentity: async () => identity,
    currentConnection: () => identity,
    exchange: async () => {
      calls++;
      throw reference.transportFailure('not-sent');
    },
  });
  await expect(
    programNativeFirmware(bundle, reference.channel, {
      operationId: 'three-attempts',
      expected: identity,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
  ).rejects.toMatchObject({
    result: { outcome: 'blocked', transportAttempts: 3, wireRequests: 0 },
  });
  expect(calls).toBe(3);
  expect(delays).toEqual([100, 200, 300]);
});

it('does not retry an ordinary ambiguous timeout or accept a delayed same-command reply on the next packet', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle),
    channel = panel.channel();
  panel.fault = { at: 0, kind: 'lost-ack' };
  await expect(programNativeFirmware(bundle, channel, options(panel))).rejects.toMatchObject({
    result: { outcome: 'unconfirmed', transportAttempts: 1, wireRequests: 1, acceptedPackets: 0 },
  });
  expect(panel.requests).toHaveLength(1);
  await expect(programNativeFirmware(bundle, channel, options(panel))).rejects.toThrow('consumed');
});

it('exercises qualified native retry separately from unproved target duplicate handling', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle);
  panel.fault = { at: 0, kind: 'reference-lost-ack' };
  const delays: number[] = [];
  await expect(
    programNativeFirmware(bundle, panel.channel(), {
      ...options(panel),
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
  ).rejects.toMatchObject({
    result: { outcome: 'rejected', targetStatus: 0xf7, transportAttempts: 2 },
  });
  expect(delays).toEqual([100]);
  const accepting = new SimulatedFirmwareBootloader(bundle);
  accepting.duplicatePolicy = 'accept-previous';
  accepting.fault = { at: 0, kind: 'reference-lost-ack' };
  const result = await programNativeFirmware(bundle, accepting.channel(), options(accepting));
  expect(result.acceptedPackets).toBe(6);
  expect(result.transportAttempts).toBe(7);
});

it.each(['stale-reply', 'wrong-command', 'disconnect'] as const)(
  'poisons a %s instead of correlating it to a later packet',
  async (kind) => {
    const panel = new SimulatedFirmwareBootloader(bundle);
    panel.fault = { at: 0, kind };
    await expect(
      programNativeFirmware(bundle, panel.channel(), options(panel)),
    ).rejects.toMatchObject({
      result: { outcome: 'unconfirmed', transportAttempts: 1, acceptedPackets: 0 },
    });
    expect(panel.requests).toHaveLength(1);
  },
);

it('requires expected bound identity and major99 before any programming request, and rejects forged channels', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle);
  panel.configuration[2] = 5;
  await expect(
    programNativeFirmware(bundle, panel.channel(), options(panel)),
  ).rejects.toMatchObject({ result: { outcome: 'blocked', wireRequests: 0 } });
  panel.configuration[2] = 99;
  await expect(
    programNativeFirmware(bundle, panel.channel(), {
      ...options(panel),
      expected: { ...panel.identity(), serial: 'OTHER-UNIT' },
    }),
  ).rejects.toMatchObject({ result: { outcome: 'blocked', wireRequests: 0 } });
  await expect(
    programNativeFirmware(bundle, {} as FirmwareProgramChannel, options(panel)),
  ).rejects.toThrow('unknown');
  expect(panel.requests).toHaveLength(0);
});

it('honors abort during durable intent with zero sends, and cancellation during a packet only after its reply without41/43', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle),
    abort = new AbortController();
  await expect(
    programNativeFirmware(bundle, panel.channel(), {
      ...options(panel),
      signal: abort.signal,
      beforeFirstProgramRequest: async () => {
        abort.abort();
      },
    }),
  ).rejects.toMatchObject({ result: { outcome: 'cancelled', wireRequests: 0 } });
  const active = new SimulatedFirmwareBootloader(bundle),
    stop = new AbortController();
  active.afterWire = () => stop.abort();
  await expect(
    programNativeFirmware(bundle, active.channel(), { ...options(active), signal: stop.signal }),
  ).rejects.toMatchObject({
    result: { outcome: 'cancelled', acceptedPackets: 1, wireRequests: 1 },
  });
  expect(active.requests.map((r) => r.payload[0])).toEqual([0x40]);
});

it('retains both-pass success separately when exit43 is unconfirmed; it never declares fresh runtime identity', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle);
  panel.fault = { at: 6, kind: 'exit-timeout' };
  const result = await programNativeFirmware(bundle, panel.channel(), options(panel));
  expect(result).toMatchObject({
    outcome: 'stream-complete',
    streamComplete: true,
    acceptedRecords: 10,
    exit: { state: 'unconfirmed', attempted: true },
  });
  expect(result).not.toHaveProperty('runtimeVerified');
  expect(panel.requests).toHaveLength(7);
});

it('suspends the current stream on pass checkpoint failure and ignores view observer errors', async () => {
  const panel = new SimulatedFirmwareBootloader(bundle);
  await expect(
    programNativeFirmware(bundle, panel.channel(), {
      ...options(panel),
      onProgress: () => {
        throw new Error('View failure');
      },
      checkpointPass: async () => {
        throw new Error('Durable checkpoint failed');
      },
    }),
  ).rejects.toBeInstanceOf(FirmwareProgramError);
  expect(panel.requests).toHaveLength(3);
  expect(panel.exitRequested).toBe(false);
});
