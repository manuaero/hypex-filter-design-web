// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ExportWorkflowSchema, prepareFileExport } from '../src/application/file-workflows';
import { newProject } from '../src/domain/model';
import { nativeCloneProjectFiles } from '../src/domain/clone-project';
import { parseNativeCloneInfo } from '../src/domain/clone-template';
import { importProjectFolder } from '../src/domain/project-io';
import { nativeCloneFixture } from './fixtures/native-clone';

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());

function fixture() {
  const design = newProject('Save metadata example');
  design.presets[0].inputEq[0].gain = 9;
  const project = structuredClone(design);
  project.hfdCloneTemplate = nativeCloneFixture();
  project.hfdCloneTemplate.eqBanks[0][0].gain = -3;
  project.hfdCloneTemplate.eqBanks[1][0].gain = -6;
  project.hfdCloneTemplate.eqBanks[2][0].gain = -9;
  const files = nativeCloneProjectFiles(project);
  const nativeSave = vi.fn(async (id: string, slot: string) => {
    if (id !== 'save-artifact' || slot !== 'left') throw Error('Unavailable fixed Save role');
    return { project, files };
  });
  return { project, files, nativeSave, documents: { left: design, right: newProject('Right') } };
}
const operation = (format: string, parameters = {}) => ({
  workflow: 'native-project-save',
  parameters: { id: 'save-artifact', slot: 'left', format, ...parameters },
});

it('requires an artifact, explicit role and format, without accepting authority, packets or implicit targets', () => {
  for (const parameters of [
    {},
    { id: 'save-artifact', slot: 'left' },
    { id: 'save-artifact', slot: 'both', format: 'folder' },
    { id: 'save-artifact', slot: 'left', format: 'folder', owner: 'forged' },
    { id: 'save-artifact', slot: 'left', format: 'folder', rawPacket: '05' },
    { id: 'save-artifact', slot: 'left', format: 'unknown' },
  ])
    expect(
      ExportWorkflowSchema.safeParse({ workflow: 'native-project-save', parameters }).success,
    ).toBe(false);
});

it('exports one captured artifact across JSON, XML and native folder without replacing staged design EQ', async () => {
  const state = fixture(),
    before = structuredClone(state.documents);
  const folder = await prepareFileExport(operation('folder'), state);
  const text = await Promise.all(
    folder.map(async (f) => ({ path: f.path, content: await f.blob.text() })),
  );
  expect(text).toEqual(state.files);
  const loaded = importProjectFolder(text);
  expect(loaded.presets[0].inputEq[0].gain).toBe(9);
  expect(loaded.hfdCloneTemplate?.eqBanks.map((b) => b[0].gain)).toEqual([-3, -6, -9]);
  const xml = await prepareFileExport(operation('hfd-xml'), state);
  expect(xml[0].blob.type).toBe('application/xml');
  expect(await xml[0].blob.text()).toBe(state.files.find((f) => f.path === 'Config.xml')!.content);
  expect(parseNativeCloneInfo(await xml[0].blob.text())?.eqBanks.map((b) => b[0].gain)).toEqual([
    -3, -6, -9,
  ]);
  const json = await prepareFileExport(operation('json'), state);
  expect(JSON.parse(await json[0].blob.text())).toEqual(state.project);
  expect(state.documents).toEqual(before);
});

it('puts the exact captured files into a portable ZIP with independently verified stored-entry CRCs', async () => {
  const state = fixture(),
    [zip] = await prepareFileExport(operation('zip'), state);
  expect(zip.blob.type).toBe('application/zip');
  const bytes = Buffer.from(await zip.blob.arrayBuffer()),
    end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  let cursor = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10),
    decoded = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(cursor + 10)).toBe(0);
    const size = bytes.readUInt32LE(cursor + 24),
      nameBytes = bytes.readUInt16LE(cursor + 28),
      name = bytes.subarray(cursor + 46, cursor + 46 + nameBytes).toString('utf8'),
      local = bytes.readUInt32LE(cursor + 42),
      start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28),
      payload = bytes.subarray(start, start + size);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    expect(crc32(payload)).toBe(bytes.readUInt32LE(cursor + 16));
    decoded.set(name, payload.toString('utf8'));
    cursor += 46 + nameBytes + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  expect(decoded).toEqual(new Map(state.files.map((f) => [f.path, f.content])));
});

it('leaves ordinary project exports offline and refuses an unavailable or differently scoped artifact', async () => {
  const state = fixture();
  await prepareFileExport({ workflow: 'project-hfd-xml', parameters: { slot: 'left' } }, state);
  expect(state.nativeSave).not.toHaveBeenCalled();
  await expect(
    prepareFileExport(operation('json'), { documents: state.documents }),
  ).rejects.toThrow('unavailable');
  await expect(prepareFileExport(operation('json', { slot: 'right' }), state)).rejects.toThrow(
    'fixed Save role',
  );
  await expect(
    prepareFileExport(operation('json', { id: 'other-artifact' }), state),
  ).rejects.toThrow('fixed Save role');
});

it('validates captured file paths before exporting an archive', async () => {
  const state = fixture();
  state.files.push({ path: '../outside.txt', content: 'forbidden' });
  await expect(prepareFileExport(operation('zip'), state)).rejects.toThrow(
    'Invalid workflow file path',
  );
});
