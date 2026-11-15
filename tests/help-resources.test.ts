import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import packageInfo from '../package.json';
import {
  createHelpResources,
  getHelpResources,
  HELP_RESOURCES,
} from '../src/application/help-resources';

const root = fileURLToPath(new URL('../', import.meta.url));
const manualPath = join(root, 'public', 'help', 'hfdhelp-v3.pdf');
const installedPdfSha256 = 'd330afbfd5502aff3d3a305144a0b82e2c371b068bc542e9a77ef5fb76989db6';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('shares one recursively immutable bounded registry across human and agent consumers', () => {
  expect(getHelpResources()).toBe(HELP_RESOURCES);
  for (const value of [
    HELP_RESOURCES,
    HELP_RESOURCES.app,
    HELP_RESOURCES.manual,
    HELP_RESOURCES.vendors,
    ...HELP_RESOURCES.vendors,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.set(HELP_RESOURCES.manual, 'generalUrl', 'https://untrusted.example/')).toBe(
    false,
  );
  expect(Reflect.set(HELP_RESOURCES.vendors[0], 'url', 'javascript:alert(1)')).toBe(false);
  expect(() => (HELP_RESOURCES.vendors as unknown as unknown[]).push({})).toThrow();
  expect(JSON.stringify(HELP_RESOURCES).length).toBeLessThan(4096);
  expect(JSON.stringify(HELP_RESOURCES)).not.toMatch(/C:\\Users|file:\/\//i);
});
it('labels package app version separately from the reference HFD software and manual versions', () => {
  expect(HELP_RESOURCES.app).toEqual({
    name: 'Fusion Studio',
    version: packageInfo.version,
    versionSource: 'package.json',
    independent: true,
  });
  expect(HELP_RESOURCES.manual.version).toBe(3);
  expect(HELP_RESOURCES.manual.nativeSoftwareVersion).toBe('5.2.4.24');
  expect(HELP_RESOURCES.app).not.toHaveProperty('build');
  expect(HELP_RESOURCES.app).not.toHaveProperty('siteVersion');
});
it('retains the native General request while navigating to the verified page 2 fallback', () => {
  const manual = HELP_RESOURCES.manual;
  expect(manual.nativeRequestedDestination).toBe('General');
  expect(manual.resolvedGeneralPage).toBe(2);
  expect(manual.pageCount).toBe(38);
  expect(manual.generalUrl).toBe(`${manual.url}#page=2`);
  expect(manual.generalUrl).not.toContain('nameddest=General');
  expect(manual.fallbackReason).toContain('no named destination General');
  expect(manual.downloadUrl).toBe(manual.url);
  expect(manual.url).toBe('/help/hfdhelp-v3.pdf');
  expect(manual.fileName).toBe('hfdhelp.pdf');
});
it('exposes only the two native vendor destinations using fixed HTTPS links', () => {
  expect(HELP_RESOURCES.vendors).toEqual([
    { id: 'hypex', title: 'Hypex', url: 'https://www.hypex.nl/' },
    { id: 'diyclassd', title: 'DIYclassD', url: 'https://www.diyclassd.com/' },
  ]);
  for (const vendor of HELP_RESOURCES.vendors) {
    const url = new URL(vendor.url);
    expect(url.protocol).toBe('https:');
    expect(url.username + url.password + url.search + url.hash).toBe('');
  }
});
it.skipIf(!existsSync(manualPath))(
  'accepts the optional exact installed PDF bytes when supplied locally',
  async () => {
    const bytes = await readFile(manualPath);
    expect(bytes.length).toBe(2_159_767);
    expect(bytes.length).toBe(HELP_RESOURCES.manual.bytes);
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.7');
    expect(digest(bytes)).toBe(installedPdfSha256);
    expect(HELP_RESOURCES.manual.sha256).toBe(installedPdfSha256);
  },
);
it('packages synthetic PDF bytes through the real worker build and static route with PDF MIME and HEAD behavior without a vendor asset', async () => {
  const parent = resolve(tmpdir()),
    directory = await mkdtemp(join(parent, 'fusion-help-worker-'));
  try {
    await mkdir(join(directory, 'out', 'help'), { recursive: true });
    await mkdir(join(directory, 'server', 'site'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(directory, 'out', 'index.html'),
      '<!doctype html><title>Static fixture</title>',
    );
    const syntheticPdf = Buffer.from(
      '%PDF-1.7\n% Synthetic routing fixture; no manual content.\n%%EOF\n',
    );
    await writeFile(join(directory, 'out', 'help', 'hfdhelp-v3.pdf'), syntheticPdf);
    // Exercise the unchanged production static handler. Its API dependency alone
    // is inert in this isolated build, so no server/database/network is involved.
    await writeFile(
      join(directory, 'server', 'site', 'index.ts'),
      await readFile(join(root, 'server', 'site', 'index.ts')),
    );
    await writeFile(
      join(directory, 'server', 'site', 'api.ts'),
      'export async function handleSiteApi() { return null; }',
    );
    const built = await promisify(execFile)(
      process.execPath,
      [join(root, 'scripts', 'build-worker.mjs')],
      { cwd: directory },
    );
    expect(built.stdout).toContain('Packaged 2 Next.js static assets');
    const moduleUrl = pathToFileURL(join(directory, 'dist', 'server', 'index.js')).href;
    const { default: worker } = (await import(/* @vite-ignore */ moduleUrl)) as {
      default: { fetch(request: Request, env: object): Promise<Response> };
    };
    const url = `https://help-fixture.invalid${HELP_RESOURCES.manual.generalUrl}`;
    const response = await worker.fetch(new Request(url), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(syntheticPdf));
    const head = await worker.fetch(new Request(url, { method: 'HEAD' }), {});
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toBe('application/pdf');
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await worker.fetch(new Request(url, { method: 'POST' }), {})).status).toBe(405);
    expect(
      (await worker.fetch(new Request('https://help-fixture.invalid/help/missing.pdf'), {})).status,
    ).toBe(404);
  } finally {
    // Only remove the exact mkdtemp directory inside the verified temp parent.
    const path = resolve(directory),
      child = relative(parent, path);
    if (
      isAbsolute(child) ||
      child.startsWith('..') ||
      !basename(path).startsWith('fusion-help-worker-')
    )
      throw new Error('Refusing cleanup outside the owned help-worker fixture');
    await rm(path, { recursive: true, force: true });
  }
}, 20000);

it('marks bundling independently of fixed reference metadata and provides a fixed official fallback', () => {
  const without = createHelpResources(false),
    withManual = createHelpResources(true);
  expect(without.manual.optional).toBe(true);
  expect(without.manual.bundled).toBe(false);
  expect(withManual.manual.bundled).toBe(true);
  expect(without.manual.fallbackUrl).toBe('https://www.hypex.nl/');
  expect({ ...without.manual, bundled: true }).toEqual(withManual.manual);
  expect(Object.isFrozen(without.manual)).toBe(true);
});
