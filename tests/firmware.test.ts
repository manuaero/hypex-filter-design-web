import { expect, it } from 'vitest';
import {
  parseFirmwareBundle,
  buildFirmwarePacketPlan,
  describeFirmwarePacketPlan,
  firmwarePacketAt,
  firmwareFamilyForHidSerial,
  assertFirmwareTarget,
  parseFirmwareResponse,
  type FirmwareBundle,
} from '../src/domain/firmware';

// Literal original records from installed HFD bundles. No firmware/device call.
const header32 = ':10000080A80D0000CA080000465553494F4E3332B0';
const header01 = ':10000080550600008D020000465553494F4E303151';
const header224 = ':10000080AD0F000042080000445350332D3232348B';
const segment2 = ':01000081027C';
const address0 = ':020000040000FA';
const fa32 = ':10068000464133320000000000000000000000007E';
const eof = ':00000001FF';
const source = [header32, segment2, address0, fa32, eof].join('\r\n') + '\r\n';
function record(type: number, data: number[], address = 0) {
  const bytes = [data.length, address >> 8, address & 255, type, ...data];
  bytes.push(-bytes.reduce((sum, value) => sum + value, 0) & 255);
  return (
    ':' +
    bytes
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

it('retains literal decoded header/data/checksum bytes and uninterpreted metadata without flattening', () => {
  const bundle = parseFirmwareBundle(source, 'DSP3-213 v5.82.hex');
  expect(bundle.family).toBe('FUSION32');
  expect(bundle.headerWords).toEqual([3496, 2250]);
  expect(bundle.name).toBe('DSP3-213 v5.82.hex');
  expect(bundle.records).toHaveLength(5);
  expect(bundle.records.map((item) => item.recordType)).toEqual([0x80, 0x81, 4, 0, 1]);
  expect(bundle.records[3]).toMatchObject({
    lineNumber: 4,
    address: 0x680,
    segment: 2,
    absoluteAddress: 0x680,
    source: fa32,
  });
  expect(bundle.records[3].bytes).toEqual([
    16, 6, 128, 0, 70, 65, 51, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 126,
  ]);
  expect(bundle.records[3].data).toEqual([70, 65, 51, 50, ...Array(12).fill(0)]);
  expect(bundle.dataBytes).toBe(16);
  expect(bundle.segments).toEqual([
    {
      id: 2,
      firstRecord: 1,
      lastRecord: 4,
      dataBytes: 16,
      minimumAddress: 0x680,
      maximumAddressExclusive: 0x690,
    },
  ]);
  expect(Object.isFrozen(bundle)).toBe(true);
  expect(Object.isFrozen(bundle.records[3].bytes)).toBe(true);
});

it('builds exact two-record packets in two complete passes, including a lone EOF and zero padding', () => {
  const bundle = parseFirmwareBundle(source),
    plan = buildFirmwarePacketPlan(bundle);
  expect(plan).toMatchObject({
    family: 'FUSION32',
    recordsPerPass: 5,
    packetsPerPass: 3,
    totalRecords: 10,
    timeoutMs: 4000,
    attempts: 3,
    failedAttemptDelaysMs: [100, 200, 300],
  });
  expect(plan.packets).toHaveLength(6);
  const expectedFirst = [
    0x40, 0, 0, 16, 0, 0, 0x80, 0xa8, 0x0d, 0, 0, 0xca, 8, 0, 0, 70, 85, 83, 73, 79, 78, 51, 50,
    0xb0, 1, 0, 0, 0x81, 2, 0x7c,
  ];
  expect(Array.from(plan.packets[0].payload)).toEqual([
    ...expectedFirst,
    ...Array(64 - expectedFirst.length).fill(0),
  ]);
  expect(Array.from(plan.packets[2].payload)).toEqual([
    0x40,
    0,
    0,
    0,
    0,
    0,
    1,
    255,
    ...Array(56).fill(0),
  ]);
  expect(
    plan.packets.map((packet) => [
      packet.pass,
      packet.index,
      packet.firstRecord,
      packet.recordCount,
      packet.completedRecords,
    ]),
  ).toEqual([
    [0, 0, 0, 2, 2],
    [0, 1, 2, 2, 4],
    [0, 2, 4, 1, 5],
    [1, 0, 0, 2, 7],
    [1, 1, 2, 2, 9],
    [1, 2, 4, 1, 10],
  ]);
  for (let i = 0; i < 3; i++) {
    expect(plan.packets[i + 3].payload.slice(3)).toEqual(plan.packets[i].payload.slice(3));
    expect(plan.packets[i + 3].payload[2]).toBe(1);
  }
  plan.packets[0].payload[3] = 99;
  expect(bundle.records[0].bytes[0]).toBe(16);
  expect(buildFirmwarePacketPlan(bundle).packets[0].payload[3]).toBe(16);
});

it('describes a validated plan without payloads and reads detached packets at arbitrary pass-local indexes', () => {
  const bundle = parseFirmwareBundle(source),
    description = describeFirmwarePacketPlan(bundle);
  expect(description).not.toHaveProperty('packets');
  expect(Object.isFrozen(description)).toBe(true);
  expect(describeFirmwarePacketPlan(bundle)).toBe(description);
  const last = firmwarePacketAt(bundle, 1, 2);
  expect(last).toMatchObject({
    pass: 1,
    index: 2,
    firstRecord: 4,
    recordCount: 1,
    completedRecords: 10,
  });
  expect(Array.from(last.payload)).toEqual([0x40, 0, 1, 0, 0, 0, 1, 255, ...Array(56).fill(0)]);
  const first = firmwarePacketAt(bundle, 0, 0);
  first.payload.fill(99);
  expect(firmwarePacketAt(bundle, 0, 0).payload[3]).toBe(16);
  const plan = buildFirmwarePacketPlan(bundle);
  expect(plan.packets.map((packet) => Array.from(packet.payload))).toEqual(
    ([0, 1] as const).flatMap((pass) =>
      [0, 1, 2].map((index) => Array.from(firmwarePacketAt(bundle, pass, index).payload)),
    ),
  );
});

it('validates every pair before any lazy packet read and rejects invalid pass/index requests', () => {
  const oversized = parseFirmwareBundle(source.replace(fa32, record(0, Array(50).fill(0), 0x680)));
  expect(() => describeFirmwarePacketPlan(oversized)).toThrow('exceed the 61-byte');
  // A request for the small first packet must still reject the oversized later pair.
  expect(() => firmwarePacketAt(oversized, 0, 0)).toThrow('exceed the 61-byte');
  const bundle = parseFirmwareBundle(source);
  for (const index of [-1, 0.5, 3, NaN, Infinity])
    expect(() => firmwarePacketAt(bundle, 0, index)).toThrow('in-range integer');
  expect(() => firmwarePacketAt(bundle, 2 as 0, 0)).toThrow('pass 0 or 1');
  expect(() => describeFirmwarePacketPlan({ ...bundle, dataBytes: 999 })).toThrow('manifest');
  expect(() => firmwarePacketAt({ ...bundle, family: 'FUSION01' }, 0, 0)).toThrow('manifest');
  const external = structuredClone(bundle);
  expect(describeFirmwarePacketPlan(external).recordsPerPass).toBe(5);
  (external.records[0].bytes as number[])[0] = 99;
  expect(() => firmwarePacketAt(external, 0, 0)).toThrow('manifest');
});

it.each([
  [header01, 'FUSION01', [1621, 653]],
  [header224, 'DSP3-224', [4013, 2114]],
] as const)(
  'recognizes the installed family header%s without inferring target authorization',
  (header, family, words) => {
    const bundle = parseFirmwareBundle(source.replace(header32, header));
    expect(bundle.family).toBe(family);
    expect(bundle.headerWords).toEqual(words);
    expect(() => assertFirmwareTarget(bundle, '0303-actual-hid')).toThrow('family mismatch');
  },
);

it('preserves repeated segment controls, upper addresses and overlapping source records in wire order', () => {
  const lines = [
    header32,
    segment2,
    address0,
    fa32,
    record(0x81, [1]),
    record(4, [0x1d, 0]),
    record(0, [1, 2, 3, 4], 0x4180),
    segment2,
    address0,
    record(0, [1], 0xff),
    eof,
  ];
  const bundle = parseFirmwareBundle(lines.join('\n'));
  expect(bundle.segments.map((segment) => [segment.id, segment.dataBytes])).toEqual([
    [2, 16],
    [1, 4],
    [2, 1],
  ]);
  expect(bundle.records[6].absoluteAddress).toBe(0x1d004180);
  expect(bundle.records[9].absoluteAddress).toBe(255);
  const plan = buildFirmwarePacketPlan(bundle);
  const reconstructed = plan.packets
    .filter((packet) => packet.pass === 0)
    .flatMap((packet) =>
      bundle.records
        .slice(packet.firstRecord, packet.firstRecord + packet.recordCount)
        .map((r) => r.source),
    );
  expect(reconstructed).toEqual(lines);
});

it('accepts legacy segment changes without demanding a new extended address record', () => {
  const lines = [header01, segment2, address0, fa32, record(0x81, [1]), ':0412000003EF0BF0FD', eof];
  const bundle = parseFirmwareBundle(lines.join('\n'));
  expect(bundle.records[5].absoluteAddress).toBe(0x1200);
  expect(bundle.segments.map((segment) => segment.id)).toEqual([2, 1]);
  expect(() => buildFirmwarePacketPlan(bundle)).not.toThrow();
  // Default linear base is also 0; packet records themselves are unchanged.
  expect(
    parseFirmwareBundle([header32, segment2, fa32, eof].join('\n')).records[2].absoluteAddress,
  ).toBe(0x680);
});

it.each(['0301', '0302', '0303', '0304'])('uses the native HID prefix%s mapping only', (prefix) => {
  expect(firmwareFamilyForHidSerial(prefix + '000001')).toBe(
    prefix === '0303' ? 'FUSION32' : prefix === '0304' ? 'FUSION03' : 'FUSION01',
  );
});

it('refuses missing/unknown/EEPROM serials and never invents a product/core family mapping', () => {
  for (const serial of ['', '030', '0305-unknown', 'H05U123456', 'SIM-LEFT'])
    expect(() => firmwareFamilyForHidSerial(serial)).toThrow('HID product serial');
  const bundle = parseFirmwareBundle(source);
  expect(() => assertFirmwareTarget(bundle, '0303-device')).not.toThrow();
  expect(() => assertFirmwareTarget(bundle, '0301-device')).toThrow('requires FUSION01');
});

it.each([
  ['', 'empty'],
  [source.replace(header32, header32.slice(0, -2) + '00'), 'checksum'],
  [source.replace(fa32, fa32.replace(':10', ':0F')), 'byte count'],
  [source.replace(fa32, ' ' + fa32), 'complete colon'],
  [source.replace(fa32, fa32 + '0'), 'complete colon'],
  [source.replace(fa32, 'not a record'), 'complete colon'],
  [source.replace(fa32, ''), 'complete colon'],
  [source.replace(header32 + '\r\n', ''), 'first record'],
  [source.replace(eof + '\r\n', ''), 'no final EOF'],
  [source + eof, 'follows the final EOF'],
  [source.replace(segment2, record(0x81, [4])), 'segment marker'],
  [source.replace(address0, record(4, [0])), 'extended linear'],
  [source.replace(fa32, record(2, [0, 0])), 'outside the recovered'],
  [source.replace(fa32, record(0x42, [])), 'outside the recovered'],
  [source.replace(fa32, header32), 'repeated native'],
  [source.replace(eof, record(1, [1])), 'invalid EOF'],
  [
    source
      .replace(address0, record(4, [255, 255]))
      .replace(fa32, record(0, Array(16).fill(0), 0xfff8)),
    'exceeds 32 bits',
  ],
])(
  'rejects malformed or outside-profile firmware without making a packet plan: %s',
  (text, message) => {
    expect(() => parseFirmwareBundle(text)).toThrow(message);
  },
);

it('rejects a packet pair exceeding the recovered61-byte capacity instead of splitting/reordering it', () => {
  const bundle = parseFirmwareBundle(source.replace(fa32, record(0, Array(50).fill(0), 0x680)));
  expect(() => buildFirmwarePacketPlan(bundle)).toThrow('exceed the 61-byte');
});

it('revalidates manifests and rejects forged family/record bytes before planning', () => {
  const bundle = parseFirmwareBundle(source);
  expect(() => buildFirmwarePacketPlan({ ...bundle, family: 'FUSION01' })).toThrow('manifest');
  const modified = structuredClone(bundle);
  (modified.records[0].bytes as number[])[0] = 0;
  expect(() => buildFirmwarePacketPlan(modified)).toThrow('manifest');
  expect(() =>
    buildFirmwarePacketPlan({ ...bundle, version: 2 } as unknown as FirmwareBundle),
  ).toThrow('Unsupported');
});

it.each([
  [0, 'ok', 'Update OK'],
  [1, 'eof', 'EOF'],
  [0x9d, 'error', 'Verify'],
  [0x9e, 'error', 'Device ID'],
  [0xf6, 'error', 'CRC'],
  [0xf7, 'error', 'Decode'],
  [0xfb, 'error', 'Program'],
  [0xff, 'error', 'Unknown type'],
  [0x44, 'error', 'Unknown firmware'],
] as const)(
  'decodes native firmware status0x%s without claiming reply correlation',
  (code, kind, message) => {
    const payload = new Uint8Array(64);
    payload[1] = code;
    const result = parseFirmwareResponse(payload);
    expect(result.statusCode).toBe(code);
    expect(result.kind).toBe(kind);
    expect(result.message).toContain(message);
    expect(() => parseFirmwareResponse(new Uint8Array(63))).toThrow('64-byte');
  },
);
