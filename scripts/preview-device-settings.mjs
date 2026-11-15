/** Local-only QA server. No production route or user/device data is loaded. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  output = join(root, 'local-data', 'device-settings-preview');
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['server/device-settings-preview.tsx'],
  outfile: join(output, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
});
await writeFile(join(output, 'styles.css'), await readFile(join(output, 'app.css')));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device settings · simulation only</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const files = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: Buffer.from(html) }],
  [
    '/app.js',
    { type: 'text/javascript; charset=utf-8', body: await readFile(join(output, 'app.js')) },
  ],
  [
    '/styles.css',
    { type: 'text/css; charset=utf-8', body: await readFile(join(output, 'styles.css')) },
  ],
]);
const server = createServer((request, response) => {
  const asset = files.get(request.url ?? '');
  if (!asset || !['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': asset.body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; object-src 'none'",
    'Permissions-Policy': 'microphone=(), camera=(), hid=(), usb=(), serial=()',
  });
  response.end(request.method === 'HEAD' ? undefined : asset.body);
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port assigned');
  console.log(`Device settings simulation only: http://127.0.0.1:${address.port}/`);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
