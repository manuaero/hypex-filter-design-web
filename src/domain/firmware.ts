/** HFD 5.2.4.24 native firmware stream, reconstructed from aa25dc/aa26e4/
 * aa2ac4. This module parses and plans only: it opens no device and sends no
 * bootloader, erase, program, cancel or reboot command. Bootloader identity,
 * reconnect and preservation/recovery still require their own proven contract. */
export type FirmwareFamily = 'FUSION01' | 'FUSION32' | 'FUSION03' | 'DSP3-224';
export type FirmwareRecordType = 0x00 | 0x01 | 0x04 | 0x80 | 0x81;
export interface FirmwareHexRecord {
  readonly lineNumber: number;
  readonly address: number;
  readonly recordType: FirmwareRecordType;
  readonly data: readonly number[];
  /** Complete original decoded Intel record, including its checksum. */
  readonly bytes: readonly number[];
  readonly source: string;
  readonly segment: number | null;
  /** Encoded Intel-HEX linear address annotation, not a segment memory-space
   * authorization. ELA starts at 0 and carries across 81 markers (legacy 1.51). */
  readonly absoluteAddress: number | null;
}
export interface FirmwareSegment {
  readonly id: number;
  /** Zero-based ordered record indexes, inclusive. Repeated IDs stay separate. */
  readonly firstRecord: number;
  readonly lastRecord: number;
  readonly dataBytes: number;
  readonly minimumAddress: number | null;
  readonly maximumAddressExclusive: number | null;
}
export interface FirmwareBundle {
  readonly format: 'hypex-firmware-bundle';
  readonly version: 1;
  readonly name: string;
  readonly family: FirmwareFamily;
  /** Uninterpreted uint32LE header words; neither is a proved byte count. */
  readonly headerWords: readonly [number, number];
  readonly records: readonly FirmwareHexRecord[];
  readonly segments: readonly FirmwareSegment[];
  readonly dataBytes: number;
}
export interface FirmwarePacket {
  readonly pass: 0 | 1;
  /** Zero-based index within this pass. */
  readonly index: number;
  readonly firstRecord: number;
  readonly recordCount: 1 | 2;
  readonly completedRecords: number;
  readonly payload: Uint8Array;
}
export interface FirmwarePlanDescription {
  readonly family: FirmwareFamily;
  readonly recordsPerPass: number;
  readonly packetsPerPass: number;
  readonly totalRecords: number;
  readonly timeoutMs: 4000;
  /** Total transport attempts, not retries for a negative firmware response. */
  readonly attempts: 3;
  /** Native waits even after its final failed attempt before returning failure. */
  readonly failedAttemptDelaysMs: readonly [100, 200, 300];
}
export interface FirmwarePacketPlan extends FirmwarePlanDescription {
  readonly packets: readonly FirmwarePacket[];
}
const FAMILIES: readonly FirmwareFamily[] = ['FUSION01', 'FUSION32', 'FUSION03', 'DSP3-224'];
const PROFILE_TYPES: readonly number[] = [0, 1, 4, 0x80, 0x81];
const MAX_TEXT_CHARACTERS = 80e6; // Shared browser text ceiling, not a native device capacity.
// Only our deeply frozen parsed objects skip subsequent full-manifest validation.
// Weak keys neither retain staged files forever nor trust mutable caller copies.
const parsedBundles = new WeakSet<FirmwareBundle>();
const planDescriptions = new WeakMap<FirmwareBundle, FirmwarePlanDescription>();
function invalid(line: number, message: string): never {
  throw new Error(`Firmware line ${line}: ${message}`);
}
const uint32LE = (bytes: readonly number[], start: number) =>
  bytes[start] + bytes[start + 1] * 256 + bytes[start + 2] * 65536 + bytes[start + 3] * 16777216;

/** Strict recovered bundle profile, not an arbitrary Intel-HEX flattener.
 * The installed host forwards original records without validating checksum;
 * this parser rejects malformed/unsupported input before a plan can exist.
 * Standard record types 02/03/05 are intentionally unavailable until target-side
 * support is proved; the three installed bundles use only 00/01/04/80/81. */
export function parseFirmwareBundle(text: string, name = 'Firmware bundle'): FirmwareBundle {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARACTERS)
    throw new Error('Firmware exceeds the browser text limit');
  const lines = text.split(/\r\n|\n|\r/);
  // A final newline is a file terminator, not another native ReadLn record.
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('Firmware bundle is empty');
  const records: FirmwareHexRecord[] = [],
    segments: FirmwareSegment[] = [];
  let family: FirmwareFamily | undefined,
    headerWords: readonly [number, number] | undefined,
    segment:
      | {
          id: number;
          firstRecord: number;
          lastRecord: number;
          dataBytes: number;
          minimumAddress: number | null;
          maximumAddressExclusive: number | null;
        }
      | undefined,
    upperAddress = 0,
    finished = false,
    dataBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      lineNumber = i + 1;
    if (finished) invalid(lineNumber, 'data follows the final EOF record');
    // Native ReadLn uses a 255-character short string. Reject truncation rather
    // than emulating a malformed partial record or ignoring blank lines.
    if (line.length > 255 || !/^:(?:[a-f\d]{2}){5,}$/i.test(line))
      invalid(lineNumber, 'expected one complete colon-prefixed hexadecimal record');
    const bytes = Array.from(line.slice(1).match(/../g)!, (pair) => parseInt(pair, 16)),
      count = bytes[0],
      address = bytes[1] * 256 + bytes[2],
      type = bytes[3];
    if (bytes.length !== count + 5) invalid(lineNumber, 'byte count does not match record length');
    if ((bytes.reduce((sum, value) => sum + value, 0) & 255) !== 0)
      invalid(lineNumber, 'Intel HEX checksum mismatch');
    if (!PROFILE_TYPES.includes(type))
      invalid(
        lineNumber,
        `record type 0x${type.toString(16)} is outside the recovered bundle profile`,
      );
    const data = Object.freeze(bytes.slice(4, -1));
    if (i === 0 && type !== 0x80)
      invalid(lineNumber, 'the first record must be the native family header');
    let absoluteAddress: number | null = null;
    if (type === 0x80) {
      if (i !== 0 || address !== 0 || count !== 16)
        invalid(lineNumber, 'invalid or repeated native family header');
      const tag = String.fromCharCode(...data.slice(8, 16));
      if (!FAMILIES.includes(tag as FirmwareFamily))
        invalid(lineNumber, `unsupported bundle family ${JSON.stringify(tag)}`);
      family = tag as FirmwareFamily;
      headerWords = Object.freeze([uint32LE(data, 0), uint32LE(data, 4)]);
    } else if (type === 0x81) {
      if (address !== 0 || count !== 1 || ![1, 2, 3].includes(data[0]))
        invalid(lineNumber, 'invalid native segment marker');
      if (segment) segments.push(Object.freeze(segment));
      segment = {
        id: data[0],
        firstRecord: i,
        lastRecord: i,
        dataBytes: 0,
        minimumAddress: null,
        maximumAddressExclusive: null,
      };
    } else if (type === 4) {
      if (!segment || address !== 0 || count !== 2)
        invalid(lineNumber, 'invalid extended linear address record');
      upperAddress = (data[0] * 256 + data[1]) * 65536;
    } else if (type === 0) {
      if (!segment) invalid(lineNumber, 'data requires a native segment');
      absoluteAddress = upperAddress + address;
      if (absoluteAddress + count > 0x100000000)
        invalid(lineNumber, 'data address exceeds 32 bits');
      segment.dataBytes += count;
      if (count) {
        segment.minimumAddress = Math.min(
          segment.minimumAddress ?? absoluteAddress,
          absoluteAddress,
        );
        segment.maximumAddressExclusive = Math.max(
          segment.maximumAddressExclusive ?? absoluteAddress + count,
          absoluteAddress + count,
        );
      }
      dataBytes += count;
    } else if (type === 1) {
      if (address !== 0 || count !== 0) invalid(lineNumber, 'invalid EOF record');
      finished = true;
    }
    if (segment) segment.lastRecord = i;
    records.push(
      Object.freeze({
        lineNumber,
        address,
        recordType: type as FirmwareRecordType,
        data,
        bytes: Object.freeze(bytes),
        source: line,
        segment: segment?.id ?? null,
        absoluteAddress,
      }),
    );
  }
  if (!finished) throw new Error('Firmware bundle has no final EOF record');
  if (!family || !headerWords || !segment || !dataBytes)
    throw new Error('Firmware bundle has no complete native segment/data profile');
  segments.push(Object.freeze(segment));
  const bundle: FirmwareBundle = Object.freeze({
    format: 'hypex-firmware-bundle',
    version: 1,
    name,
    family,
    headerWords,
    records: Object.freeze(records),
    segments: Object.freeze(segments),
    dataBytes,
  });
  parsedBundles.add(bundle);
  return bundle;
}

/** d06d94 uses a HID product serial prefix, NOT the EEPROM identity serial.
 * WebHID does not currently provide this value through HIDDevice. Do not infer
 * a family from product 22/core 5.1 without an independently proved mapping. */
export function firmwareFamilyForHidSerial(hidSerial: string): FirmwareFamily {
  const prefix = typeof hidSerial === 'string' ? hidSerial.slice(0, 4) : '';
  if (prefix === '0301' || prefix === '0302') return 'FUSION01';
  if (prefix === '0303') return 'FUSION32';
  if (prefix === '0304') return 'FUSION03';
  throw new Error(
    'Firmware target requires a known HID product serial prefix; EEPROM serial is insufficient',
  );
}
export function assertFirmwareTarget(bundle: FirmwareBundle, hidSerial: string): void {
  const required = firmwareFamilyForHidSerial(hidSerial);
  if (bundle.family !== required)
    throw new Error(
      `Firmware family mismatch: target requires ${required}, bundle is ${bundle.family}`,
    );
}

function checkedFirmwareBundle(bundle: FirmwareBundle): FirmwareBundle {
  if (bundle?.format !== 'hypex-firmware-bundle' || bundle.version !== 1)
    throw new Error('Unsupported firmware bundle');
  if (parsedBundles.has(bundle)) return bundle;
  // Revalidate caller-supplied manifests. Do not cache mutable external objects.
  const checked = parseFirmwareBundle(
    bundle.records.map((record) => record.source).join('\n'),
    bundle.name,
  );
  if (JSON.stringify(bundle) !== JSON.stringify(checked))
    throw new Error('Firmware manifest no longer matches its original records');
  return checked;
}

/** Validate every original pair once, without constructing any packet payload.
 * Parsed bundles are deeply immutable, so repeated descriptions and page reads
 * reuse this validation. This does not authorize the target or live execution. */
export function describeFirmwarePacketPlan(bundle: FirmwareBundle): FirmwarePlanDescription {
  const checked = checkedFirmwareBundle(bundle),
    cached = planDescriptions.get(checked);
  if (cached) return cached;
  const count = checked.records.length;
  for (let first = 0; first < count; first += 2) {
    const pair = checked.records.slice(first, first + 2),
      length = pair.reduce((size, record) => size + record.bytes.length, 0);
    if (length > 61)
      throw new Error(
        `Firmware records ${first + 1}..${first + pair.length} exceed the 61-byte packet payload`,
      );
  }
  const description: FirmwarePlanDescription = Object.freeze({
    family: checked.family,
    recordsPerPass: count,
    packetsPerPass: Math.ceil(count / 2),
    totalRecords: 2 * count,
    timeoutMs: 4000,
    attempts: 3,
    failedAttemptDelaysMs: Object.freeze([100, 200, 300] as const),
  });
  planDescriptions.set(checked, description);
  return description;
}

/** Exact aa26e4 packet at a zero-based index WITHIN the specified pass. A fresh
 * detached 64-byte payload is returned; no other packet payload is allocated. */
export function firmwarePacketAt(
  bundle: FirmwareBundle,
  pass: 0 | 1,
  index: number,
): FirmwarePacket {
  const checked = checkedFirmwareBundle(bundle),
    description = describeFirmwarePacketPlan(checked);
  if (
    (pass !== 0 && pass !== 1) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= description.packetsPerPass
  )
    throw new Error('Firmware packet requires pass 0 or 1 and an in-range integer packet index');
  const first = index * 2,
    pair = checked.records.slice(first, first + 2),
    payload = new Uint8Array(64);
  payload.set([0x40, 0, pass]);
  let offset = 3;
  for (const record of pair) {
    payload.set(record.bytes, offset);
    offset += record.bytes.length;
  }
  return Object.freeze({
    pass,
    index,
    firstRecord: first,
    recordCount: pair.length as 1 | 2,
    completedRecords: pass * checked.records.length + first + pair.length,
    payload,
  });
}

/** aa26e4/aa2ac4: two records per 64-byte payload, original checksums/order,
 * passes 0 then 1. No flattening, padding records, automatic reordering or live I/O.
 * Refuse oversized pairs instead of reproducing native unchecked buffer copies. */
export function buildFirmwarePacketPlan(bundle: FirmwareBundle): FirmwarePacketPlan {
  const checked = checkedFirmwareBundle(bundle),
    description = describeFirmwarePacketPlan(checked),
    packets: FirmwarePacket[] = [];
  for (const pass of [0, 1] as const)
    for (let index = 0; index < description.packetsPerPass; index++)
      packets.push(firmwarePacketAt(checked, pass, index));
  return Object.freeze({ ...description, packets: Object.freeze(packets) });
}

export type FirmwareResponse = {
  statusCode: number;
  kind: 'ok' | 'eof' | 'error';
  message: string;
};
/** aa2816..aa2975 status-byte interpretation only. This is NOT response/header
 * correlation or proof of a bootloader ACK; a future transport must establish
 * the full expected reply envelope before using this status. */
export function parseFirmwareResponse(payload: Uint8Array): FirmwareResponse {
  if (!(payload instanceof Uint8Array) || payload.length !== 64)
    throw new Error('Firmware response requires a 64-byte HID payload');
  const statusCode = payload[1];
  if (statusCode === 0) return { statusCode, kind: 'ok', message: 'Update OK' };
  if (statusCode === 1) return { statusCode, kind: 'eof', message: 'Update EOF found' };
  const errors: Record<number, string> = {
    0x9d: 'Update Verify error',
    0x9e: 'Update Device ID mismatch',
    0xf6: 'Update CRC error',
    0xf7: 'Update Decode error',
    0xfb: 'Update Program error',
    0xff: 'Update Unknown type error',
  };
  return {
    statusCode,
    kind: 'error',
    message:
      errors[statusCode] ??
      `Unknown firmware response 0x${statusCode.toString(16).padStart(2, '0')}`,
  };
}
