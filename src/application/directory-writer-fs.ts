import type {
  WritableProjectDirectoryHandle,
  WritableProjectFileHandle,
} from './project-directory-writer';
import { Sha256 } from './file-transfers';
import { assertFileByteBudget } from './file-budget';

export const directoryNameKey = (name: string) => name.normalize('NFC').toLowerCase();
export function assertSaveName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 255 ||
    /[\\/\u0000-\u001f:*?"<>|]/.test(value) ||
    /[ .]$/.test(value) ||
    value === '.' ||
    value === '..' ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    throw new Error('Use a single native-compatible project or file name');
}
export function isWritableProjectDirectory(
  value: unknown,
): value is WritableProjectDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const h = value as WritableProjectDirectoryHandle;
  return (
    h.kind === 'directory' &&
    typeof h.name === 'string' &&
    typeof h.queryPermission === 'function' &&
    typeof h.values === 'function' &&
    typeof h.getDirectoryHandle === 'function' &&
    typeof h.getFileHandle === 'function' &&
    typeof h.isSameEntry === 'function'
  );
}
export async function hasDirectoryWritePermission(handle: WritableProjectDirectoryHandle) {
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
export const isMissingDirectoryEntry = (error: unknown) =>
  !!error && typeof error === 'object' && 'name' in error && error.name === 'NotFoundError';
export async function findChildDirectory(root: WritableProjectDirectoryHandle, name: string) {
  assertSaveName(name);
  let found: WritableProjectDirectoryHandle | undefined,
    count = 0;
  for await (const child of root.values()) {
    if (++count > 10000) throw new Error('Directory entry budget exceeded');
    if (directoryNameKey(child.name) !== directoryNameKey(name)) continue;
    if (found || child.kind !== 'directory')
      throw new Error('Project directory name is ambiguous or collides with a file');
    found = child;
  }
  return found;
}
export async function matchingProjectFiles(
  folder: WritableProjectDirectoryHandle,
  names: readonly string[],
) {
  const result = new Map<string, WritableProjectFileHandle>();
  let count = 0;
  for await (const child of folder.values()) {
    if (++count > 10000) throw new Error('Project folder entry budget exceeded');
    const key = directoryNameKey(child.name);
    if (!names.some((name) => directoryNameKey(name) === key)) continue;
    if (result.has(key) || child.kind !== 'file')
      throw new Error('Project filename is ambiguous or collides with a directory');
    result.set(key, child);
  }
  return result;
}
export async function hashDirectoryBlob(blob: Blob): Promise<string> {
  assertFileByteBudget([blob]);
  const hash = new Sha256(),
    reader = blob.stream().getReader();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > blob.size) throw new Error('File stream exceeded its declared size');
      hash.update(chunk.value);
    }
    if (size !== blob.size) throw new Error('File stream ended early');
    return hash.digest();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export type WritableProjectDirectoryPicker = (options: {
  mode: 'readwrite';
  id: string;
}) => Promise<WritableProjectDirectoryHandle>;
/** Human event only; service/MCP never invokes this chooser. */
export async function pickWritableProjectDirectory(
  picker?: WritableProjectDirectoryPicker,
): Promise<WritableProjectDirectoryHandle | undefined> {
  const choose =
    picker ??
    (typeof window !== 'undefined'
      ? (
          window as unknown as { showDirectoryPicker?: WritableProjectDirectoryPicker }
        ).showDirectoryPicker?.bind(window)
      : undefined);
  if (!choose) throw new Error('Directory writes are unavailable; export a project folder instead');
  try {
    const handle = await choose({ mode: 'readwrite', id: 'fusion-studio-project-save' });
    if (!isWritableProjectDirectory(handle)) throw new Error('Invalid directory capability');
    return handle;
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
      return;
    throw new Error('Choose a project database folder with explicit write access');
  }
}
export async function withDirectoryWriteLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new Error(
      'Exclusive browser filesystem locks are unavailable; use project folder export',
    );
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another browser save owns this project directory');
    return work();
  });
}

/** getFile snapshots can expire after a disk edit. Copy bytes eagerly before any write.
 * https://developer.chrome.com/docs/capabilities/web-apis/file-system-access */
export async function ownDirectoryBlob(file: Blob): Promise<Blob> {
  assertFileByteBudget([file]);
  const reader = file.stream().getReader(),
    parts: ArrayBuffer[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > file.size) throw new Error('File exceeds declared size');
      const bytes = new Uint8Array(next.value.byteLength);
      bytes.set(next.value);
      parts.push(bytes.buffer);
    }
    if (count !== file.size) throw new Error('File stream ended early');
    return new Blob(parts);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
