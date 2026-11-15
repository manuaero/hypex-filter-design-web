// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProjectLibrary from '../src/components/ProjectLibrary';
import { newProject, type Project } from '../src/domain/model';
import { projectFiles } from '../src/domain/project-io';
import { MAX_UI_FILE_BYTES, MAX_UI_TOTAL_BYTES } from '../src/application/file-budget';

const storage = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), trash: vi.fn() }));
vi.mock('../src/hardware/storage', () => ({
  listProjects: storage.list,
  saveProject: storage.save,
  trashProject: storage.trash,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  storage.list.mockResolvedValue([]);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(storage.save).not.toHaveBeenCalled();
  expect(storage.trash).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

async function render(
  project: Project,
  replace: (project: Project) => void,
  onError: (e: string) => void,
) {
  await act(async () => root.render(<ProjectLibrary {...{ project, replace, onError }} />));
}
function picker() {
  return host.querySelector<HTMLInputElement>('input[type="file"]')!;
}
async function openFolder() {
  const button = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Open HFD folder'),
  )!;
  await act(async () => button.click());
}
function select(files: File[]) {
  const input = picker();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

it('keeps the clicked destination through both a role change in the chooser and a slow native-folder read', async () => {
  const originalLeft = vi.fn<(project: Project) => void>(),
    rightDuringChooser = vi.fn<(project: Project) => void>(),
    rightDuringRead = vi.fn<(project: Project) => void>(),
    onError = vi.fn(),
    readStarted = deferred(),
    releaseRead = deferred(),
    design = newProject('Native fixture');
  design.presets[0].channels[0].gain = -3;
  design.presets[0].channels[0].measurement = {
    name: 'Original impulse',
    sampleRate: 48000,
    impulse: [0, 1, 0, 0],
  };
  // Deliberately omit the browser sidecar: exercise the real XML/DAT parser.
  const files = projectFiles(design)
    .filter((file) => file.path !== 'FusionProject.json')
    .map(({ path, content }) => {
      const bytes = new TextEncoder().encode(content);
      return {
        name: path,
        webkitRelativePath: `Native fixture/${path}`,
        size: bytes.length,
        stream: () =>
          path === 'Config.xml'
            ? new ReadableStream<Uint8Array>({
                async start(controller) {
                  readStarted.resolve();
                  await releaseRead.promise;
                  controller.enqueue(bytes);
                  controller.close();
                },
              })
            : new NodeBlob([bytes]).stream(),
      } as File;
    });

  await render(newProject('Left'), originalLeft, onError);
  expect(picker().hasAttribute('webkitdirectory')).toBe(true);
  await openFolder();
  await render(newProject('Right'), rightDuringChooser, onError);
  await act(async () => {
    select(files);
    await readStarted.promise;
  });
  expect(originalLeft).not.toHaveBeenCalled();
  await render(newProject('Right again'), rightDuringRead, onError);
  await act(async () => releaseRead.resolve());

  expect(onError).not.toHaveBeenCalled();
  expect(originalLeft).toHaveBeenCalledTimes(1);
  expect(rightDuringChooser).not.toHaveBeenCalled();
  expect(rightDuringRead).not.toHaveBeenCalled();
  const imported = originalLeft.mock.calls[0][0];
  expect(imported.name).toBe('Native fixture');
  expect(imported.presets[0].channels[0].gain).toBe(-3);
  expect(imported.presets[0].channels[0].measurement?.impulse).toEqual([0, 1, 0, 0]);
  expect(imported.presets[0].channels[0].measurement?.sampleRate).toBe(48000);
  expect(imported.sourceXml).toContain('<project');
  expect(storage.list).toHaveBeenCalledTimes(2);
  expect(picker().value).toBe('');
});

it('rejects individual and aggregate byte overflow before reading any selected file', async () => {
  const replace = vi.fn(),
    onError = vi.fn(),
    stream = vi.fn(),
    text = vi.fn();
  const metadata = (size: number, name = 'Config.xml') =>
    ({
      name,
      size,
      stream,
      text,
    }) as unknown as File;
  await render(newProject(), replace, onError);
  for (const files of [
    [metadata(MAX_UI_FILE_BYTES + 1)],
    [
      metadata(MAX_UI_FILE_BYTES),
      metadata(MAX_UI_FILE_BYTES, 'P1_CH1.dat'),
      metadata(MAX_UI_TOTAL_BYTES - 2 * MAX_UI_FILE_BYTES + 1, 'P1_CH2.dat'),
    ],
  ]) {
    onError.mockClear();
    await openFolder();
    await act(async () => select(files));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('byte budget');
  }
  expect(stream).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(storage.list).toHaveBeenCalledTimes(1);
});

it('leaves a cancelled folder chooser quiet without replacing or refreshing the library', async () => {
  const replace = vi.fn(),
    onError = vi.fn();
  await render(newProject(), replace, onError);
  const click = vi.spyOn(picker(), 'click').mockImplementation(() => {});
  await openFolder();
  await act(async () => select([]));
  expect(click).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(storage.list).toHaveBeenCalledTimes(1);
});
