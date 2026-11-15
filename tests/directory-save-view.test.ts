import { expect, it } from 'vitest';
import {
  directoryProposalPage,
  directorySnapshotPage,
} from '../src/application/directory-save-view';
import type {
  DirectorySaveProposal,
  DirectoryWriterSnapshot,
} from '../src/application/project-directory-writer';

function proposal(index: number, archived = false): DirectorySaveProposal {
  return {
    id: `save-${index}`,
    slot: index % 2 ? 'left' : 'right',
    expectedRevision: 7,
    mode: 'save-as',
    rootId: 'root',
    folderName: `Folder${index}`,
    phase: 'complete',
    createdAt: index,
    requiresOverwriteConfirmation: false,
    recoveryAvailable: !archived,
    workspaceChanged: false,
    ...(archived ? { archived: true as const, archivedAt: 1000 } : {}),
    files: Array.from({ length: 105 }, (_, file) => ({
      path: `file-${file}.dat`,
      action: 'replace' as const,
      bytes: 2,
      sha256: 'a'.repeat(64),
      state: 'verified' as const,
      recovery: 'pending' as const,
    })),
  };
}
function snapshot(): DirectoryWriterSnapshot {
  return {
    phase: 'ready',
    hydrated: true,
    busy: false,
    error: null,
    roots: [{ id: 'root', label: 'Database' }],
    associations: {},
    saves: Array.from({ length: 53 }, (_, index) => proposal(index, index % 3 === 0)),
  };
}

it('paginates active history separately from archived receipts while retaining bounded file pages and input ownership', () => {
  const state = snapshot(),
    original = structuredClone(state),
    active = state.saves.filter((save) => !save.archived),
    first = directorySnapshotPage(state);
  expect(first).toMatchObject({ totalSaves: 35, archivedSaves: 18, offset: 0, nextOffset: 20 });
  expect(first.saves.map((save) => save.id)).toEqual(active.slice(0, 20).map((save) => save.id));
  expect(
    first.saves.every(
      (save) => !save.archived && save.files.length === 40 && save.totalFiles === 105,
    ),
  ).toBe(true);
  const second = directorySnapshotPage(state, { offset: 20 });
  expect(second.saves).toHaveLength(15);
  expect(second.nextOffset).toBeNull();
  const archived = directorySnapshotPage(state, { includeArchived: true, offset: 50, limit: 3 });
  expect(archived).toMatchObject({
    totalSaves: 53,
    archivedSaves: 18,
    offset: 50,
    nextOffset: null,
  });
  expect(archived.saves.map((save) => save.id)).toEqual(['save-50', 'save-51', 'save-52']);
  expect(archived.saves[1]).toMatchObject({ archived: true, recoveryAvailable: false });
  expect(state).toEqual(original);
  expect(first.saves).not.toBe(state.saves);
  expect(first.saves[0].files).not.toBe(active[0].files);
});

it('pages exact archived file metadata without dropping historical receipt flags and handles offsets past the end', () => {
  const source = { ...proposal(1, true), verified: true, replayed: true, atomic: false as const },
    page = directoryProposalPage(source, { fileOffset: 100, fileLimit: 4 });
  expect(page).toMatchObject({
    archived: true,
    recoveryAvailable: false,
    verified: true,
    replayed: true,
    atomic: false,
    totalFiles: 105,
    fileOffset: 100,
    nextFileOffset: 104,
  });
  expect(page.files.map((file) => file.path)).toEqual([
    'file-100.dat',
    'file-101.dat',
    'file-102.dat',
    'file-103.dat',
  ]);
  expect(directoryProposalPage(source, { fileOffset: 104, fileLimit: 4 })).toMatchObject({
    files: [source.files[104]],
    nextFileOffset: null,
  });
  expect(directoryProposalPage(source, { fileOffset: 1000 })).toMatchObject({
    files: [],
    totalFiles: 105,
    nextFileOffset: null,
  });
});

it('rejects invalid page bounds before returning either history or file metadata', () => {
  for (const options of [
    { offset: -1 },
    { offset: 0.5 },
    { offset: Infinity },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ])
    expect(() => directorySnapshotPage(snapshot(), options)).toThrow(/page/);
  for (const options of [
    { fileOffset: -1 },
    { fileOffset: NaN },
    { fileLimit: 0 },
    { fileLimit: 101 },
  ])
    expect(() => directoryProposalPage(proposal(1), options)).toThrow(/page/);
});

it('bounds introduced/restored historical receipt paths with the same file page and retains their full counts', () => {
  const source = {
      ...proposal(1, true),
      introduced: Array.from({ length: 101 }, (_, index) => `new-${index}.dat`),
      restored: Array.from({ length: 103 }, (_, index) => `original-${index}.xml`),
    },
    original = structuredClone(source),
    first = directoryProposalPage(source),
    last = directoryProposalPage(source, { fileOffset: 100, fileLimit: 4 });
  expect(first.introduced).toHaveLength(40);
  expect(first.restored).toHaveLength(40);
  expect(last).toMatchObject({
    introduced: ['new-100.dat'],
    restored: ['original-100.xml', 'original-101.xml', 'original-102.xml'],
    totalIntroduced: 101,
    totalRestored: 103,
  });
  expect(last.introduced).not.toBe(source.introduced);
  expect(last.restored).not.toBe(source.restored);
  expect(source).toEqual(original);
});
