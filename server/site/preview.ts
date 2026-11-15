/** Loopback-only QA host for the exact built Worker. Identity is explicitly
 * simulated here; production authentication belongs to the Sites gateway. */
import { createServer } from 'node:http';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Statement, type SiteEnv } from './api';
async function main() {
  const worker = (await import(pathToFileURL(resolve('dist/server/index.js')).href)).default;
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('drizzle/0000_browser_bridge.sql', 'utf8'));
  class Query implements Statement {
    values: SQLInputValue[] = [];
    constructor(readonly sql: string) {}
    bind(...v: unknown[]) {
      this.values = v as SQLInputValue[];
      return this;
    }
    async run() {
      return { meta: { changes: Number(db.prepare(this.sql).run(...this.values).changes) } };
    }
    async first<T>() {
      return (db.prepare(this.sql).get(...this.values) as T) ?? null;
    }
    async all<T>() {
      return { results: db.prepare(this.sql).all(...this.values) as T[] };
    }
  }
  const objects = new Map<string, string>(),
    env: SiteEnv = {
      DB: { prepare: (sql) => new Query(sql) },
      BUCKET: {
        put: async (k, v) => {
          objects.set(k, v);
        },
        get: async (k) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
        delete: async (keys) => {
          for (const k of typeof keys === 'string' ? [keys] : keys) objects.delete(k);
        },
      },
    };
  createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 9e6) throw Error('Request too large');
        chunks.push(c);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      headers.set('oai-authenticated-user-id', 'local-preview-owner');
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks) } : {}),
      });
      const response: Response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  }).listen(3212, '127.0.0.1', () =>
    console.log(
      'Built Worker QA: http://fusion.localhost:3212 (simulated Site identity, no amplifier simulation)',
    ),
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
