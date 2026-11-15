import { type Project, uid } from '../domain/model';
import { openDB } from 'idb';
import type { FirBackup } from './fir';
import type { Backup, ConfigurationBackup } from './session';
let connection: ReturnType<typeof openDB> | undefined;
const database = () =>
  (connection ??= openDB('fusion-studio', 4, {
    blocking() {
      connection?.then((db) => db.close());
      connection = undefined;
    },
    upgrade(db) {
      if (!db.objectStoreNames.contains('projects'))
        db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('firBackups'))
        db.createObjectStore('firBackups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('backups'))
        db.createObjectStore('backups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('configurationBackups'))
        db.createObjectStore('configurationBackups', { keyPath: 'id' });
    },
  }));
export async function saveBackup(backup: Backup) {
  const db = await database();
  await db.put('backups', backup);
  const saved = await db.get('backups', backup.id);
  if (JSON.stringify(saved) !== JSON.stringify(backup))
    throw new Error('Backup persistence failed; programming cancelled');
}
export async function listBackups(): Promise<Backup[]> {
  return (await (await database()).getAll('backups')).sort((a, b) => b.utc.localeCompare(a.utc));
}
export async function saveConfigurationBackup(backup: ConfigurationBackup) {
  const db = await database();
  await db.put('configurationBackups', backup);
  if (JSON.stringify(await db.get('configurationBackups', backup.id)) !== JSON.stringify(backup))
    throw new Error('Configuration backup failed');
}
export async function listConfigurationBackups(): Promise<ConfigurationBackup[]> {
  return (await (await database()).getAll('configurationBackups')).sort((a, b) =>
    b.utc.localeCompare(a.utc),
  );
}

export async function saveFirBackup(backup: FirBackup) {
  const db = await database();
  await db.put('firBackups', backup);
  if (JSON.stringify(await db.get('firBackups', backup.id)) !== JSON.stringify(backup))
    throw new Error('FIR backup persistence failed; programming cancelled');
}
export async function listFirBackups(): Promise<FirBackup[]> {
  return (await (await database()).getAll('firBackups')).sort((a, b) => b.utc.localeCompare(a.utc));
}

export interface SavedProject {
  id: string;
  utc: string;
  name: string;
  project: Project;
  trashed?: boolean;
}
export async function saveProject(project: Project) {
  const record: SavedProject = {
    id: uid(),
    utc: new Date().toISOString(),
    name: project.name,
    project: structuredClone(project),
  };
  await (await database()).put('projects', record);
  return record;
}
export async function listProjects(): Promise<SavedProject[]> {
  return (await (await database()).getAll('projects')).sort((a, b) => b.utc.localeCompare(a.utc));
}
/** Resolve one vault reference without reading every project's measurement arrays. */
export async function getProject(id: string): Promise<SavedProject | undefined> {
  return (await database()).get('projects', id);
}
export async function trashProject(id: string, trashed: boolean) {
  const db = await database(),
    p = await db.get('projects', id);
  if (!p) throw new Error('Saved project not found');
  p.trashed = trashed;
  await db.put('projects', p);
}
