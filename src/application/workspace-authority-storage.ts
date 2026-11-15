import { openDirectoryWriterDatabase } from './directory-writer-storage';

export interface StoredWorkspaceAuthority {
  version: 1;
  id: string;
}
export const WORKSPACE_AUTHORITY_KEY = 'workspace';
export function parseStoredWorkspaceAuthority(value: unknown): StoredWorkspaceAuthority {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'version') ||
    !Object.hasOwn(value, 'id') ||
    (value as StoredWorkspaceAuthority).version !== 1 ||
    typeof (value as StoredWorkspaceAuthority).id !== 'string' ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test((value as StoredWorkspaceAuthority).id)
  )
    throw new Error('Saved workspace authority is invalid; prior data was retained');
  return { version: 1, id: (value as StoredWorkspaceAuthority).id };
}
/** Atomic strict-durability creation. Missing data alone permits a new UUID; invalid data never does. */
export async function loadOrCreateWorkspaceAuthority(): Promise<StoredWorkspaceAuthority> {
  const database = await openDirectoryWriterDatabase();
  const tx = database.transaction('authority', 'readwrite', { durability: 'strict' });
  let expected: StoredWorkspaceAuthority;
  try {
    if (tx.durability !== 'strict')
      throw new Error('Strict workspace-authority durability is unavailable');
    const prior = await tx.store.get(WORKSPACE_AUTHORITY_KEY);
    expected =
      prior === undefined
        ? { version: 1, id: crypto.randomUUID() }
        : parseStoredWorkspaceAuthority(prior);
    parseStoredWorkspaceAuthority(expected);
    if (prior === undefined) await tx.store.put(expected, WORKSPACE_AUTHORITY_KEY);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await tx.done.catch(() => {});
    throw error;
  }
  const confirmed = parseStoredWorkspaceAuthority(
    await database.get('authority', WORKSPACE_AUTHORITY_KEY),
  );
  if (confirmed.id !== expected.id)
    throw new Error('Workspace authority readback differs; prior data was retained');
  return Object.freeze(confirmed);
}
