// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { newProject, type Project } from '../src/domain/model';
import { spectrum, processMeasurement } from '../src/domain/measurement';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import { projectFiles } from '../src/domain/project-io';
import { readDirectoryProject } from '../src/application/directory-project-source';
import { prepareFileImport } from '../src/application/file-workflows';
import type { ProjectDirectoryHandle, ProjectFileHandle } from '../src/application/project-sources';
import ProjectLibrary from '../src/components/ProjectLibrary';

const storage = vi.hoisted(() => ({ list: vi.fn(async () => []), save: vi.fn(), trash: vi.fn() }));
vi.mock('../src/hardware/storage', () => ({
  listProjects: storage.list,
  saveProject: storage.save,
  trashProject: storage.trash,
  listBackups: vi.fn(async () => []),
  listFirBackups: vi.fn(async () => []),
  listConfigurationBackups: vi.fn(async () => []),
}));
beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
const bom = String.fromCharCode(0xfeff),
  correction = bom + '20 6\r\n1000 6\r\n20000 6\r\n';
function fixture() {
  const project = newProject('BOM source is exact');
  project.presets[0].channels[0].measurement = processMeasurement(
    spectrum(
      Array.from({ length: 128 }, (_, i) => (i === 20 ? 1 : i === 30 ? 0.25 : 0)),
      48000,
    ),
    { window: { start: 10, end: 70, taper: 0.2, timeZero: 20 }, smoothingOctaves: 1 / 3 },
  );
  loadProjectMicrophone(project, correction, 'Mic.txt');
  const files = projectFiles(project).map(({ path, content }) => ({
    path,
    file: new NodeFile([/\.json$/i.test(path) ? bom + content : content], path, {
      lastModified: 1000,
    }) as unknown as File,
  }));
  return { project, files };
}
function expectExact(actual: Project, expected: Project) {
  expect(actual.warnings.some((warning) => warning.startsWith('Restored browser-only'))).toBe(true);
  expect(actual.warnings.some((warning) => warning.startsWith('Ignored FusionProject.json'))).toBe(
    false,
  );
  expect({ ...actual, warnings: expected.warnings }).toEqual(expected);
  expect(actual.hfdCalibration?.resource?.content).toBe(correction);
}
class Directory implements ProjectDirectoryHandle {
  readonly kind = 'directory' as const;
  children: (ProjectDirectoryHandle | ProjectFileHandle)[] = [];
  constructor(readonly name: string) {}
  async queryPermission(_: { mode: 'read' }): Promise<PermissionState> {
    return 'granted';
  }
  async getDirectoryHandle(name: string) {
    const child = this.children.find((entry) => entry.kind === 'directory' && entry.name === name);
    if (!child) throw new Error('Missing');
    return child as ProjectDirectoryHandle;
  }
  async *values() {
    yield* this.children;
  }
  async isSameEntry(other: ProjectDirectoryHandle): Promise<boolean> {
    return this === other;
  }
}
afterEach(() => vi.clearAllMocks());
it('fresh granted-directory reads retain native BOM text and legacy BOM JSON sidecars', async () => {
  const f = fixture(),
    root = new Directory('database'),
    folder = new Directory('Speaker');
  root.children.push(folder);
  folder.children = f.files.map(({ path, file }) => ({
    kind: 'file' as const,
    name: path,
    getFile: async () => file,
  }));
  expectExact(await readDirectoryProject(root, 'Speaker'), f.project);
});
it('MCP folder imports retain exact BOM calibration source and full browser processing state', async () => {
  const f = fixture(),
    prepared = await prepareFileImport(
      { workflow: 'folder', parameters: { target: 'right' }, expectedRevision: 0 },
      f.files.map(({ path, file }) => ({ path, blob: file })),
    ),
    actual = newProject('Destination');
  prepared.apply(actual);
  expectExact(actual, f.project);
  expect(prepared.slots).toEqual(['right']);
});
it('the human folder-picker path uses the same native BOM preservation while JSON remains parseable', async () => {
  const f = fixture(),
    host = document.createElement('div'),
    root = createRoot(host),
    replace = vi.fn(),
    onError = vi.fn();
  document.body.append(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    await act(async () =>
      root.render(<ProjectLibrary project={newProject()} replace={replace} onError={onError} />),
    );
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Open HFD folder'))!
        .click(),
    );
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!,
      files = f.files.map(({ path, file }) => {
        Object.defineProperty(file, 'webkitRelativePath', { value: `Speaker/${path}` });
        return file;
      });
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onError).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expectExact(replace.mock.calls[0][0], f.project);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.trash).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it('preserving BOM never hides a genuinely edited microphone file behind a browser snapshot', async () => {
  const f = fixture(),
    changed = bom + '20 3\r\n1000 3\r\n20000 3\r\n';
  const prepared = await prepareFileImport(
      { workflow: 'folder', parameters: { target: 'left' }, expectedRevision: 0 },
      f.files.map(({ path, file }) => ({
        path,
        blob: path === 'Mic.txt' ? (new NodeFile([changed], path) as unknown as File) : file,
      })),
    ),
    actual = newProject();
  prepared.apply(actual);
  expect(actual.warnings.join(' ')).toContain('Ignored FusionProject.json');
  expect(actual.hfdCalibration?.resource?.content).toBe(changed);
});
