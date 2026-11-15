import type { TransferBlobFile } from './file-transfers';
import { MAX_UI_FILE_BYTES, MAX_UI_TOTAL_BYTES } from './file-budget';

export const MAX_RECOVERY_ZIP_ENTRIES = 4001;
const ZIP32_MAX = 0xffffffff;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Recovery ZIP creation was cancelled', 'AbortError');
}
function zipPath(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes(':'))
    throw new Error('Recovery ZIP requires safe relative file paths');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('Recovery ZIP requires safe relative file paths');
  // TextEncoder replaces unpaired surrogates. Refuse that lossy filename
  // conversion rather than inventing an archive name or missing an alias.
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = normalized.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Recovery ZIP filename contains invalid Unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new Error('Recovery ZIP filename contains invalid Unicode');
  }
  return normalized;
}
async function blobCrc32(blob: Blob, signal?: AbortSignal): Promise<number> {
  abort(signal);
  const reader = blob.stream().getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let count = 0,
    crc = 0xffffffff;
  try {
    while (true) {
      abort(signal);
      const { value, done } = await reader.read();
      abort(signal);
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new Error('Recovery file stream returned invalid bytes');
      count += value.byteLength;
      if (count > blob.size || count > MAX_UI_FILE_BYTES)
        throw new Error('Recovery file stream exceeds its declared byte budget');
      for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    }
    if (count !== blob.size)
      throw new Error('Recovery file stream ended before its declared byte length');
    return (crc ^ 0xffffffff) >>> 0;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Binary-safe ZIP32/store export. Recovery before-images are never decoded,
 * re-encoded or materialized as whole ArrayBuffers: checksum each stream, then
 * assemble headers and the original immutable Blobs. Includes all ZIP overhead
 * in the shared browser total-byte budget. This performs no I/O beyond reading
 * the supplied Blobs and never initiates a download or modifies a journal. */
export async function createRecoveryZip(
  files: readonly TransferBlobFile[],
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  abort(options.signal);
  if (!Array.isArray(files) || !files.length || files.length > MAX_RECOVERY_ZIP_ENTRIES)
    throw new Error(`Recovery ZIP requires 1–${MAX_RECOVERY_ZIP_ENTRIES} files`);
  const encoder = new TextEncoder(),
    names = new Set<string>();
  let localBytes = 0,
    centralBytes = 0;
  // Snapshot and validate every manifest field before opening the first stream.
  const entries = files.map((file) => {
    if (!file || !(file.blob instanceof Blob))
      throw new Error('Recovery ZIP requires immutable file Blobs');
    const path = zipPath(file.path),
      key = path.normalize('NFC').toLowerCase(),
      name = encoder.encode(path),
      blob = file.blob,
      size = blob.size;
    if (names.has(key)) throw new Error('Recovery ZIP filenames have duplicate NFC/case aliases');
    names.add(key);
    if (!name.length || name.length > 65535)
      throw new Error('Recovery ZIP filename exceeds ZIP32 limits');
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UI_FILE_BYTES || size > ZIP32_MAX)
      throw new Error('Recovery ZIP file exceeds its byte budget or ZIP32 limits');
    const offset = localBytes;
    localBytes += 30 + name.length + size;
    centralBytes += 46 + name.length;
    if (
      !Number.isSafeInteger(localBytes + centralBytes) ||
      localBytes > ZIP32_MAX ||
      centralBytes > ZIP32_MAX
    )
      throw new Error('Recovery ZIP exceeds ZIP32 limits');
    if (localBytes + centralBytes + 22 > MAX_UI_TOTAL_BYTES)
      throw new Error('Recovery ZIP exceeds the total byte budget including archive headers');
    return { name, blob, size, offset };
  });
  if (localBytes + centralBytes + 22 > ZIP32_MAX)
    throw new Error('Recovery ZIP exceeds ZIP32 limits');
  const local: BlobPart[] = [],
    central: BlobPart[] = [];
  for (const entry of entries) {
    const crc = await blobCrc32(entry.blob, options.signal),
      header = new Uint8Array(30 + entry.name.length),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true); // UTF-8, known CRC/sizes, no data descriptor.
    h.setUint16(12, 0x21, true); // 1980-01-01, deterministic DOS date.
    h.setUint32(14, crc, true);
    h.setUint32(18, entry.size, true);
    h.setUint32(22, entry.size, true);
    h.setUint16(26, entry.name.length, true);
    header.set(entry.name, 30);
    local.push(header, entry.blob);
    const record = new Uint8Array(46 + entry.name.length),
      c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, entry.size, true);
    c.setUint32(24, entry.size, true);
    c.setUint16(28, entry.name.length, true);
    c.setUint32(42, entry.offset, true);
    record.set(entry.name, 46);
    central.push(record);
  }
  abort(options.signal);
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralBytes, true);
  e.setUint32(16, localBytes, true);
  const archive = new Blob([...local, ...central, end], { type: 'application/zip' });
  if (archive.size !== localBytes + centralBytes + end.length)
    throw new Error('Recovery ZIP size did not match its validated manifest');
  return archive;
}
