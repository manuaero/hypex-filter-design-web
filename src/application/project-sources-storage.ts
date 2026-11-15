import { openDB, type IDBPDatabase } from 'idb';
import { assertProjectSourcesWrite } from './project-sources-format';
import type { ProjectSourcesBackend, ProjectSourcesEnvelope } from './project-sources';

/** Separate database: no changes to project-vault, backup or workspace schemas. */
export function createIndexedDbProjectSourcesBackend(): ProjectSourcesBackend {
  let database: Promise<IDBPDatabase> | undefined;
  const connect = () => {
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable'));
    database ??= openDB('fusion-studio-project-sources', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources');
      },
      blocking() {
        void database?.then((db) => db.close());
        database = undefined;
      },
      terminated() {
        database = undefined;
      },
    }).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };
  return {
    async read() {
      return (await (await connect()).get('sources', 'database')) ?? null;
    },
    async write(next: ProjectSourcesEnvelope, expectedRevision: number | null) {
      const db = await connect(),
        transaction = db.transaction('sources', 'readwrite');
      try {
        const current = (await transaction.store.get('database')) ?? null;
        assertProjectSourcesWrite(current, next, expectedRevision);
        await transaction.store.put(next, 'database');
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {}
        await transaction.done.catch(() => {});
        throw error;
      }
    },
  };
}
