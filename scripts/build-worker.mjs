import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { build } from 'esbuild';
const types = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain;charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};
const assets = {},
  walk = (path) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file);
      else
        assets['/' + relative('out', file).replaceAll('\\', '/')] = {
          base64: readFileSync(file).toString('base64'),
          type: types[extname(file)] ?? 'application/octet-stream',
        };
    }
  };
walk('out');
mkdirSync('dist/server', { recursive: true });
await build({
  entryPoints: ['server/site/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  minify: true,
  define: {
    'process.env.NEXT_PUBLIC_HFD_MANUAL_BUNDLED': JSON.stringify(
      assets['/help/hfdhelp-v3.pdf'] ? 'true' : 'false',
    ),
  },
  plugins: [
    {
      name: 'static-export-assets',
      setup(b) {
        b.onResolve({ filter: /assets\.generated$/ }, () => ({
          path: 'assets',
          namespace: 'static-export',
        }));
        b.onLoad({ filter: /.*/, namespace: 'static-export' }, () => ({
          contents: 'export default ' + JSON.stringify(assets),
          loader: 'js',
        }));
      },
    },
  ],
});
console.log(
  `Packaged ${Object.keys(assets).length} Next.js static assets with the authenticated Site MCP Worker.`,
);
