import { importProjectFolder, type ProjectFile } from '../domain/project-io';
import { projectSchema } from '../domain/files';
import {
  assertFileByteBudget,
  MAX_UI_FILE_COUNT,
  MAX_UI_TEXT_CHARACTERS,
  readFileText,
} from './file-budget';
import type { ProjectDirectoryHandle, ProjectFileHandle } from './project-sources';

export const MAX_DATABASE_PROJECTS = 2000;
const MAX_DIRECTORY_ENTRIES = 10000;
const MAX_PROJECT_DEPTH = 32;

/** A single granted-directory child, never an absolute path or caller traversal. */
export function assertDirectoryEntryName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/\u0000]/.test(name)
  )
    throw new Error('Invalid granted-directory entry name');
}
export function isProjectDirectoryHandle(value: unknown): value is ProjectDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const handle = value as ProjectDirectoryHandle;
  return (
    handle.kind === 'directory' &&
    typeof handle.name === 'string' &&
    typeof handle.queryPermission === 'function' &&
    typeof handle.getDirectoryHandle === 'function' &&
    typeof handle.values === 'function' &&
    typeof handle.isSameEntry === 'function'
  );
}
export async function hasProjectReadPermission(handle: ProjectDirectoryHandle): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
export interface DirectoryProjectEntry {
  folderName: string;
  label: string;
  modifiedAt: number;
}
/** Direct children only. Directory enumeration never requests or expands a grant. */
export async function listDirectoryProjects(
  root: ProjectDirectoryHandle,
): Promise<DirectoryProjectEntry[]> {
  const entries: DirectoryProjectEntry[] = [];
  let count = 0;
  for await (const child of root.values()) {
    if (++count > MAX_DIRECTORY_ENTRIES)
      throw new Error('Database directory exceeds the entry budget');
    assertDirectoryEntryName(child.name);
    if (child.kind !== 'directory') continue;
    let config: ProjectFileHandle | undefined;
    let childCount = 0;
    for await (const candidate of child.values()) {
      if (++childCount > MAX_DIRECTORY_ENTRIES)
        throw new Error('Project directory exceeds the entry budget');
      assertDirectoryEntryName(candidate.name);
      if (candidate.kind === 'file' && candidate.name.toLowerCase() === 'config.xml') {
        config = candidate;
        break;
      }
    }
    if (!config) continue;
    const file = await config.getFile();
    if (!Number.isFinite(file.lastModified) || file.lastModified < 0)
      throw new Error('Invalid project modification time');
    entries.push({
      folderName: child.name,
      label: child.name,
      modifiedAt: Math.floor(file.lastModified / 2000) * 2000,
    });
    if (entries.length > MAX_DATABASE_PROJECTS)
      throw new Error('Database exceeds the 2000-project budget');
  }
  return entries;
}

/** Reads a fresh snapshot only from descendants of this granted project folder. */
export async function readDirectoryProject(root: ProjectDirectoryHandle, folderName: string) {
  assertDirectoryEntryName(folderName);
  const folder = await root.getDirectoryHandle(folderName);
  const files: { path: string; file: File }[] = [];
  let visited = 0;
  const visit = async (
    directory: ProjectDirectoryHandle,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_PROJECT_DEPTH) throw new Error('Project folder exceeds the nesting budget');
    for await (const child of directory.values()) {
      if (++visited > MAX_DIRECTORY_ENTRIES)
        throw new Error('Project folder exceeds the entry budget');
      assertDirectoryEntryName(child.name);
      const path = prefix + child.name;
      if (child.kind === 'directory') await visit(child, path + '/', depth + 1);
      else if (child.kind === 'file') {
        if (files.length >= MAX_UI_FILE_COUNT)
          throw new Error('Project folder exceeds the 2000-file budget');
        const file = await child.getFile();
        files.push({ path, file });
        // Reject oversized blobs before opening any text stream.
        assertFileByteBudget(files.map(({ file: current }) => current));
      } else throw new Error('Invalid project directory entry');
    }
  };
  await visit(folder, '', 0);
  assertFileByteBudget(files.map(({ file }) => file));
  if (files.filter(({ path }) => path.toLowerCase() === 'config.xml').length !== 1)
    throw new Error('Project folder must contain one unambiguous Config.xml');
  const text: ProjectFile[] = [];
  let remaining = MAX_UI_TEXT_CHARACTERS;
  for (const { path, file } of files) {
    const content = await readFileText(file, remaining, { preserveBom: !/\.json$/i.test(path) });
    remaining -= content.length;
    text.push({ path, content });
  }
  return projectSchema.parse(importProjectFolder(text, folderName));
}

export type ProjectDirectoryPicker = (options: {
  mode: 'read';
  id: string;
}) => Promise<ProjectDirectoryHandle>;
/** Call directly in a human click handler. MCP must never call this picker. */
export async function pickProjectDirectory(
  picker?: ProjectDirectoryPicker,
): Promise<ProjectDirectoryHandle | undefined> {
  const choose =
    picker ??
    (typeof window !== 'undefined'
      ? (
          window as unknown as { showDirectoryPicker?: ProjectDirectoryPicker }
        ).showDirectoryPicker?.bind(window)
      : undefined);
  if (!choose) throw new Error('Directory access is unavailable; use folder import instead');
  try {
    const handle = await choose({ mode: 'read', id: 'fusion-studio-project-database' });
    if (!isProjectDirectoryHandle(handle)) throw new Error('Invalid directory capability');
    return handle;
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError'
    )
      return undefined;
    throw new Error('Directory selection failed; choose a readable project database folder');
  }
}
