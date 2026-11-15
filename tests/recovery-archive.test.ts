import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { expect, it } from 'vitest';
import { createRecoveryZip, MAX_RECOVERY_ZIP_ENTRIES } from '../src/application/recovery-archive';
import { MAX_UI_FILE_BYTES, MAX_UI_TOTAL_BYTES } from '../src/application/file-budget';

/** Independent ZIP/store reader: follows the central directory rather than
 * assuming the encoder's input order, and checks data with Node's zlib CRC. */
async function unzipStored(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer()),
    end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 4)).toBe(0);
  expect(bytes.readUInt16LE(end + 6)).toBe(0);
  expect(bytes.readUInt16LE(end + 20)).toBe(0);
  const count = bytes.readUInt16LE(end + 10),
    centralSize = bytes.readUInt32LE(end + 12),
    centralOffset = bytes.readUInt32LE(end + 16),
    result = new Map<string, Buffer>();
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  expect(centralOffset + centralSize).toBe(end);
  let position = centralOffset;
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(position)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(position + 8)).toBe(0x800);
    expect(bytes.readUInt16LE(position + 10)).toBe(0);
    const size = bytes.readUInt32LE(position + 24),
      compressed = bytes.readUInt32LE(position + 20),
      nameSize = bytes.readUInt16LE(position + 28),
      extra = bytes.readUInt16LE(position + 30),
      comment = bytes.readUInt16LE(position + 32),
      localOffset = bytes.readUInt32LE(position + 42),
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(position + 46, position + 46 + nameSize),
      );
    expect(compressed).toBe(size);
    expect(bytes.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(localOffset + 6)).toBe(0x800);
    expect(bytes.readUInt16LE(localOffset + 8)).toBe(0);
    expect(bytes.readUInt32LE(localOffset + 18)).toBe(size);
    expect(bytes.readUInt32LE(localOffset + 22)).toBe(size);
    const localName = bytes.readUInt16LE(localOffset + 26),
      localExtra = bytes.readUInt16LE(localOffset + 28),
      start = localOffset + 30 + localName + localExtra,
      payload = bytes.subarray(start, start + compressed);
    expect(bytes.subarray(localOffset + 30, localOffset + 30 + localName)).toEqual(
      bytes.subarray(position + 46, position + 46 + nameSize),
    );
    expect(payload.length).toBe(size);
    expect(start + compressed).toBeLessThanOrEqual(centralOffset);
    expect(crc32(payload)).toBe(bytes.readUInt32LE(position + 16));
    expect(bytes.readUInt32LE(localOffset + 14)).toBe(crc32(payload));
    expect(result.has(name)).toBe(false);
    result.set(name, payload);
    position += 46 + nameSize + extra + comment;
  }
  expect(position).toBe(end);
  return result;
}

it('independently extracts manifest and exact binary before/desired images, including invalidUTF8, NUL, BOM and CRLF', async () => {
  const original = Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 0xc0, 0xaf),
    desired = Uint8Array.from({ length: 256 }, (_, index) => index),
    manifest = '{"phase":"partial","atomic":false}\r\n',
    archive = await createRecoveryZip([
      { path: 'manifest.json', blob: new Blob([manifest]) },
      { path: 'before/Cafe\u0301.bin', blob: new Blob([original]) },
      { path: 'desired/🔊.bin', blob: new Blob([desired]) },
      { path: 'desired/empty.bin', blob: new Blob([]) },
      { path: 'desired/checksum.txt', blob: new Blob(['123456789']) },
    ]),
    entries = await unzipStored(archive);
  expect(archive.type).toBe('application/zip');
  expect(entries.get('manifest.json')).toEqual(Buffer.from(manifest));
  expect(entries.get('before/Cafe\u0301.bin')).toEqual(Buffer.from(original));
  expect(entries.get('desired/🔊.bin')).toEqual(Buffer.from(desired));
  expect(entries.get('desired/empty.bin')).toHaveLength(0);
  expect(crc32(entries.get('desired/checksum.txt')!)).toBe(0xcbf43926);
});

it('streams CRC across irregular chunks without reading whole original Blobs or interpreting their content', async () => {
  const payload = Uint8Array.of(0xff, 0, 0x81, 13, 10, 77, 0, 0xfe);
  class StreamOnly extends Blob {
    streamed = 0;
    override async arrayBuffer(): Promise<ArrayBuffer> {
      throw new Error('Whole-file materialization is forbidden');
    }
    override async text(): Promise<string> {
      throw new Error('Text decoding is forbidden');
    }
    override stream() {
      this.streamed++;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(payload.subarray(0, 1));
          controller.enqueue(payload.subarray(1, 5));
          controller.enqueue(payload.subarray(5));
          controller.close();
        },
      });
    }
  }
  const source = new StreamOnly([payload]),
    files = [{ path: 'before\\raw.bin', blob: source }],
    pending = createRecoveryZip(files);
  files[0] = { path: 'changed-after-capture.bin', blob: new StreamOnly([]) };
  const extracted = await unzipStored(await pending);
  expect([...extracted.keys()]).toEqual(['before/raw.bin']);
  expect(extracted.get('before/raw.bin')).toEqual(Buffer.from(payload));
  expect(source.streamed).toBe(1);
});

it('rejects traversal, absolute/drive paths, lossy Unicode and NFC/case aliases before reading any file', async () => {
  let streams = 0;
  class NotRead extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      streams++;
      throw new Error('No stream should open');
    }
  }
  const blob = new NotRead(['original']);
  for (const path of [
    '',
    '../file',
    'before/../file',
    '..\\file',
    '/root/file',
    '\\root\\file',
    '//host/share',
    'C:\\file',
    'C:file',
    './file',
    'a//b',
    'a/./b',
    'name\0.bin',
    'bad\ud800.bin',
  ])
    await expect(createRecoveryZip([{ path, blob }])).rejects.toThrow();
  await expect(
    createRecoveryZip([
      { path: 'before/Café.bin', blob },
      { path: 'BEFORE/Cafe\u0301.bin', blob },
    ]),
  ).rejects.toThrow(/aliases/);
  await expect(
    createRecoveryZip([
      { path: 'before\\file.bin', blob },
      { path: 'before/file.bin', blob },
    ]),
  ).rejects.toThrow(/aliases/);
  expect(streams).toBe(0);
});

it('preflights the per-file and whole-archive budgets, ZIP name limits and entry count without materializing large data', async () => {
  let streams = 0;
  class Sized extends Blob {
    constructor(readonly declared: number) {
      super([]);
    }
    override get size() {
      return this.declared;
    }
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      streams++;
      throw new Error('Budget validation must precede reads');
    }
  }
  await expect(
    createRecoveryZip([{ path: 'large.bin', blob: new Sized(MAX_UI_FILE_BYTES + 1) }]),
  ).rejects.toThrow(/budget/);
  // Payload alone fits640MB, but archive headers must also fit that same cap.
  await expect(
    createRecoveryZip([
      { path: 'first.bin', blob: new Sized(MAX_UI_TOTAL_BYTES / 2) },
      { path: 'second.bin', blob: new Sized(MAX_UI_TOTAL_BYTES / 2) },
    ]),
  ).rejects.toThrow(/total byte budget/);
  await expect(
    createRecoveryZip([{ path: 'x'.repeat(65536), blob: new Sized(0) }]),
  ).rejects.toThrow(/ZIP32/);
  await expect(
    createRecoveryZip(
      Array.from({ length: MAX_RECOVERY_ZIP_ENTRIES + 1 }, (_, index) => ({
        path: `${index}.bin`,
        blob: new Sized(0),
      })),
    ),
  ).rejects.toThrow(/4001/);
  await expect(createRecoveryZip([])).rejects.toThrow();
  expect(streams).toBe(0);
});

it('supports the maximum4001 recovery files with valid independent directory offsets and no ZIP64', async () => {
  const empty = new Blob([]),
    entries = await unzipStored(
      await createRecoveryZip(
        Array.from({ length: MAX_RECOVERY_ZIP_ENTRIES }, (_, index) => ({
          path: `part/${index}.bin`,
          blob: empty,
        })),
      ),
    );
  expect(entries.size).toBe(4001);
});

it('aborts a pending stream, releases it and never returns a partial archive', async () => {
  let cancelled = 0;
  class Pending extends Blob {
    override stream() {
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        cancel() {
          cancelled++;
        },
      });
    }
  }
  const controller = new AbortController(),
    pending = createRecoveryZip(
      [{ path: 'before/file.bin', blob: new Pending([Uint8Array.of(1)]) }],
      { signal: controller.signal },
    );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(1);
  await expect(
    createRecoveryZip([{ path: 'unused', blob: new Pending([]) }], { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(1);
});

it.each([1, 3])(
  'refuses a file stream reporting%d bytes for an immutable2-byte manifest entry',
  async (count) => {
    class Incorrect extends Blob {
      override stream() {
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            controller.enqueue(new Uint8Array(count));
            controller.close();
          },
        });
      }
    }
    await expect(
      createRecoveryZip([{ path: 'before/file.bin', blob: new Incorrect([Uint8Array.of(1, 2)]) }]),
    ).rejects.toThrow(/declared byte/);
  },
);
