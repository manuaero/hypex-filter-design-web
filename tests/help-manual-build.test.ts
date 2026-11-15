import { build, transform } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
async function inFixture(work: (directory: string) => Promise<void>) {
  const parent = resolve(tmpdir()),
    directory = await mkdtemp(join(parent, 'fusion-optional-help-'));
  try {
    await work(directory);
  } finally {
    const path = resolve(directory),
      child = relative(parent, path);
    if (
      isAbsolute(child) ||
      child.startsWith('..') ||
      !basename(path).startsWith('fusion-optional-help-')
    )
      throw new Error('Refusing unsafe fixture cleanup');
    await rm(path, { recursive: true, force: true });
  }
}
it('derives the actual Next client flag from a file, with absent and directory paths failing closed', async () => {
  await inFixture(async (directory) => {
    const config = join(directory, 'next.config.mjs');
    await build({
      entryPoints: [join(root, 'next.config.ts')],
      outfile: config,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    for (const kind of ['absent', 'file', 'directory']) {
      const cwd = join(directory, kind),
        manual = join(cwd, 'public', 'help', 'hfdhelp-v3.pdf');
      await mkdir(join(cwd, 'public', 'help'), { recursive: true });
      if (kind === 'file') await writeFile(manual, '%PDF-1.7\nSynthetic presence fixture\n');
      if (kind === 'directory') await mkdir(manual);
      const output = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const {default:config}=await import(${JSON.stringify(pathToFileURL(config).href)});process.stdout.write(config.env.NEXT_PUBLIC_HFD_MANUAL_BUNDLED);`,
        ],
        { cwd },
      );
      expect(output.stdout).toBe(kind === 'file' ? 'true' : 'false');
    }
  });
}, 20000);

it.each([false, true])(
  'imports the actual Worker/API without process and keeps optional manual metadata aligned with assets (bundled=%s)',
  async (present) => {
    await inFixture(async (directory) => {
      await mkdir(join(directory, 'out', 'help'), { recursive: true });
      await mkdir(join(directory, 'server', 'site'), { recursive: true });
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(directory, 'out', 'index.html'),
        '<!doctype html><title>Optional vendor asset</title>',
      );
      if (present)
        await writeFile(
          join(directory, 'out', 'help', 'hfdhelp-v3.pdf'),
          '%PDF-1.7\nSynthetic routing fixture only\n',
        );
      const registry = join(root, 'src', 'application', 'help-resources.ts').replaceAll('\\', '/'),
        api = join(root, 'server', 'site', 'api.ts').replaceAll('\\', '/');
      // Real production static handler AND API dependency tree. This named export
      // exposes the same compiled registry solely for metadata assertions.
      await writeFile(
        join(directory, 'server', 'site', 'index.ts'),
        (await readFile(join(root, 'server', 'site', 'index.ts'), 'utf8')) +
          `\nexport {HELP_RESOURCES as testHelpResources} from ${JSON.stringify(registry)};`,
      );
      await writeFile(
        join(directory, 'server', 'site', 'api.ts'),
        `export {handleSiteApi} from ${JSON.stringify(api)};`,
      );
      const built = await promisify(execFile)(
        process.execPath,
        [join(root, 'scripts', 'build-worker.mjs')],
        { cwd: directory },
      );
      expect(built.stdout).toContain(`Packaged ${present ? 2 : 1} Next.js static assets`);
      const output = await readFile(join(directory, 'dist', 'server', 'index.js'), 'utf8'),
        compiled = await transform(output, { format: 'iife', globalName: 'WorkerFixture' });
      const sandbox = {
        Request,
        Response,
        URL,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        Blob,
        atob,
        btoa,
        crypto,
        console,
      } as Record<string, unknown>;
      runInNewContext(compiled.code, sandbox);
      expect('process' in sandbox).toBe(false);
      const { default: worker, testHelpResources } = sandbox.WorkerFixture as {
        default: { fetch(request: Request, env: object): Promise<Response> };
        testHelpResources: { manual: { bundled: boolean; optional: boolean; fallbackUrl: string } };
      };
      expect(testHelpResources.manual.bundled).toBe(present);
      expect(testHelpResources.manual.optional).toBe(true);
      expect(testHelpResources.manual.fallbackUrl).toBe('https://www.hypex.nl/');
      const index = await worker.fetch(new Request('https://optional-help.invalid/'), {});
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('Optional vendor asset');
      expect(
        (await worker.fetch(new Request('https://optional-help.invalid/help/hfdhelp-v3.pdf'), {}))
          .status,
      ).toBe(present ? 200 : 404);
    });
  },
  20000,
);

it('defaults unbundled reference metadata to unavailable in a process-free runtime', async () => {
  const result = await build({
      entryPoints: [join(root, 'src', 'application', 'help-resources.ts')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'RegistryFixture',
      write: false,
    }),
    sandbox = {} as Record<string, unknown>;
  runInNewContext(result.outputFiles[0].text, sandbox);
  expect(
    (sandbox.RegistryFixture as { HELP_RESOURCES: { manual: { bundled: boolean } } }).HELP_RESOURCES
      .manual.bundled,
  ).toBe(false);
});
