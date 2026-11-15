// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProjectSaveDialog, {
  type ProjectSaveDialogProps,
} from '../src/components/ProjectSaveDialog';
import {
  DirectorySaveError,
  type DirectorySaveBinding,
  type DirectorySaveInput,
  type DirectorySaveProposal,
  type DirectorySaveReceipt,
  type DirectoryArchiveReview,
  type DirectoryWriterSnapshot,
  type ProjectDirectoryWriter,
  type WritableProjectDirectoryHandle,
} from '../src/application/project-directory-writer';
import type {
  DirectoryLegacyAccess,
  DirectoryLegacyReview,
} from '../src/application/workspace-directory';

const recoveryZip = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/application/recovery-archive', () => ({ createRecoveryZip: recoveryZip.create }));

const principal = { owner: 'browser:tab', scope: 'ui:save' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let snapshot: DirectoryWriterSnapshot = {
    phase: 'ready',
    hydrated: true,
    busy: false,
    error: null,
    roots: [{ id: 'root-a', label: 'Granted database' }],
    associations: {},
    saves: [],
  };
  const listeners = new Set<() => void>();
  let latest: DirectorySaveProposal;
  const publish = (patch: Partial<DirectoryWriterSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((fn) => fn());
  };
  const makeProposal = (input: DirectorySaveInput): DirectorySaveProposal => ({
    id: `save-${input.requestId}`,
    slot: input.slot,
    expectedRevision: input.expectedRevision,
    mode: input.mode,
    rootId: input.mode === 'save-as' ? input.rootId : 'root-a',
    folderName: input.mode === 'save-as' ? input.folderName : 'Existing',
    phase: 'prepared',
    createdAt: 123,
    recoveryAvailable: true,
    workspaceChanged: false,
    requiresOverwriteConfirmation: true,
    files: [
      {
        path: 'P1_CH1.dat',
        action: 'create',
        bytes: 8,
        sha256: 'a'.repeat(64),
        state: 'pending',
        recovery: 'pending',
      },
      {
        path: 'Config.xml',
        action: 'replace',
        bytes: 20,
        beforeBytes: 12,
        beforeSha256: 'b'.repeat(64),
        sha256: 'c'.repeat(64),
        state: 'pending',
        recovery: 'pending',
      },
      {
        path: 'FusionProject.json',
        action: 'unchanged',
        bytes: 40,
        sha256: 'd'.repeat(64),
        state: 'pending',
        recovery: 'pending',
      },
    ],
  });
  const completed = (phase: DirectorySaveReceipt['phase'] = 'complete'): DirectorySaveReceipt => ({
    ...latest,
    phase,
    verified: true,
    replayed: false,
    atomic: false,
    introduced: ['P1_CH1.dat'],
    restored: phase === 'complete' ? [] : ['Config.xml'],
    files: latest.files.map((file) => ({
      ...file,
      state: 'verified',
      recovery:
        phase === 'complete'
          ? 'pending'
          : file.action === 'create'
            ? 'retained-new-file'
            : 'restored',
    })),
  });
  const prepare = vi.fn(async (input: DirectorySaveInput) => {
    latest = makeProposal(input);
    publish({ saves: [latest] });
    return latest;
  });
  const commit = vi.fn(async () => {
    const receipt = completed();
    publish({
      saves: [receipt],
      associations: { [receipt.slot]: { rootId: receipt.rootId, folderName: receipt.folderName } },
    });
    return receipt;
  });
  const retry = vi.fn(async () => completed()),
    recover = vi.fn(async () => completed('recovered-with-new-files'));
  const handle: WritableProjectDirectoryHandle = {
    kind: 'directory',
    name: 'Chosen database',
    queryPermission: vi.fn(async () => 'granted' as const),
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(),
    values: vi.fn(),
    isSameEntry: vi.fn(),
  };
  const registerDirectory = vi.fn(async () => {
    publish({ roots: [{ id: 'root-a', label: 'Chosen database' }] });
    return 'root-a';
  });
  const status = vi.fn(
      async (id: string) => snapshot.saves.find((save) => save.id === id) ?? latest,
    ),
    forgetRecovery = vi.fn(async () => {}),
    exportRecovery = vi.fn(async () => [
      { path: 'before/Config.xml', blob: new Blob([new Uint8Array([0xff, 0, 0x0d, 0x0a])]) },
    ]);
  const reviewArchive = vi.fn(async (id: string): Promise<DirectoryArchiveReview> => {
    const saved = snapshot.saves.find((save) => save.id === id) ?? latest;
    if (
      !['complete', 'recovered', 'recovered-with-new-files'].includes(saved.phase) ||
      saved.archived
    )
      throw new DirectorySaveError('conflict', 'Only completed unarchived records can be reviewed');
    return {
      id: `archive-${id}`,
      saveId: id,
      slot: saved.slot,
      phase: saved.phase as DirectoryArchiveReview['phase'],
      envelopeRevision: 42,
      manifestSha256: 'e'.repeat(64),
      recoveryBytes: 80,
      proposal: saved,
    };
  });
  const archive = vi.fn(async (reviewId: string): Promise<DirectorySaveReceipt> => {
    const id = reviewId.replace(/^archive-/, ''),
      saved = snapshot.saves.find((save) => save.id === id) ?? latest,
      result: DirectorySaveReceipt = {
        ...saved,
        archived: true,
        archivedAt: 124,
        recoveryAvailable: false,
        verified: true,
        replayed: true,
        atomic: false,
        introduced: ['P1_CH1.dat'],
        restored: [],
      };
    publish({ saves: snapshot.saves.map((save) => (save.id === id ? result : save)) });
    return result;
  });
  const writer: ProjectDirectoryWriter & Partial<DirectoryLegacyAccess> = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    hydrate: vi.fn(async () => {}),
    retryStorage: vi.fn(async () => {}),
    registerDirectory,
    forgetRoot: vi.fn(async () => {}),
    prepare,
    commit,
    retry,
    status,
    recover,
    exportRecovery,
    forgetRecovery,
    reviewArchive,
    archive,
  };
  return {
    writer,
    prepare,
    commit,
    retry,
    recover,
    registerDirectory,
    status,
    exportRecovery,
    forgetRecovery,
    reviewArchive,
    archive,
    handle,
    publish,
    completed,
  };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  recoveryZip.create
    .mockReset()
    .mockImplementation(async () => new Blob(['zip-fixture'], { type: 'application/zip' }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};
async function text(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Project folder name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function props(
  f: ReturnType<typeof fixture>,
  extra: Partial<ProjectSaveDialogProps> = {},
): ProjectSaveDialogProps {
  return {
    writer: f.writer,
    captureBinding: vi.fn((): DirectorySaveBinding => ({
      slot: 'left',
      expectedRevision: 7,
      requestId: 'first-request',
      principal,
    })),
    projectName: 'Original design',
    onError: vi.fn(),
    onSaved: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
}
async function mount(p: ProjectSaveDialogProps) {
  await act(async () => root.render(<ProjectSaveDialog {...p} />));
}
async function approve() {
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(
        'section[aria-label="Prepared folder save"] input[type="checkbox"]',
      )!
      .click(),
  );
}

it('opens a captured-role modal without a chooser or write and keeps binding/label/download callback fixed across navigation', async () => {
  const f = fixture(),
    picker = vi.fn(async () => f.handle),
    json = vi.fn(),
    p = props(f, { picker, onDownloadJson: json });
  await mount(p);
  expect(host.querySelector('dialog')!.getAttribute('aria-modal')).toBe('true');
  expect(host.textContent).toContain('Left · Original design');
  expect(picker).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
  await mount({
    ...p,
    projectName: 'New role design',
    captureBinding: () => ({ slot: 'right', expectedRevision: 99, requestId: 'new', principal }),
    onDownloadJson: vi.fn(),
  });
  expect(p.captureBinding).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Left · Original design');
  await click('Download JSON');
  expect(json).toHaveBeenCalledTimes(1);
  await click('Review save');
  expect(f.prepare).toHaveBeenCalledWith({
    slot: 'left',
    expectedRevision: 7,
    requestId: 'first-request',
    principal,
    mode: 'save-as',
    rootId: 'root-a',
    folderName: 'Original design',
  });
});
it('calls the human-only readwrite chooser only on click and never prepares or commits on grant', async () => {
  const f = fixture(),
    picker = vi.fn(async () => f.handle),
    p = props(f, { picker });
  await mount(p);
  await click('Choose parent folder…');
  expect(picker).toHaveBeenCalledWith({ mode: 'readwrite', id: 'fusion-studio-project-save' });
  expect(f.registerDirectory).toHaveBeenCalledWith(f.handle);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
});
it('reviews create/replace/unchanged first, requires explicit overwrite, and invalidates review when its folder changes', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  const review = host.querySelector('section[aria-label="Prepared folder save"]')!;
  expect(review.textContent).toContain('create');
  expect(review.textContent).toContain('replace');
  expect(review.textContent).toContain('unchanged');
  expect(button('Save reviewed files').disabled).toBe(true);
  await click('Save reviewed files');
  expect(f.commit).not.toHaveBeenCalled();
  await approve();
  expect(button('Save reviewed files').disabled).toBe(false);
  await text('Second folder');
  expect(host.querySelector('section[aria-label="Prepared folder save"]')).toBeNull();
  await click('Review save');
  const next = f.prepare.mock.calls[1][0];
  expect(next.requestId).not.toBe('first-request');
  expect(next).toMatchObject({ slot: 'left', expectedRevision: 7, folderName: 'Second folder' });
  expect(f.commit).not.toHaveBeenCalled();
});
it('Save As completion cannot silently switch operation mode or reuse its consumed request after a new association appears', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  await approve();
  await click('Save reviewed files');
  expect(f.commit).toHaveBeenCalledWith('save-first-request', principal, { allowOverwrite: true });
  expect(p.onSaved).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('All project files verified.');
  await click('Review save');
  const again = f.prepare.mock.calls[1][0];
  expect(again).toMatchObject({
    mode: 'save-as',
    rootId: 'root-a',
    folderName: 'Original design',
    slot: 'left',
    expectedRevision: 7,
  });
  expect(again.requestId).not.toBe('first-request');
});
it('ambiguous commit failure holds the reviewed request and enables same-folder regrant, exact Retry and recovery without retargeting', async () => {
  const f = fixture(),
    picker = vi.fn(async () => f.handle),
    p = props(f, { picker });
  f.commit.mockRejectedValueOnce(new DirectorySaveError('persistence', 'Receipt readback failed'));
  await mount(p);
  await click('Review save');
  await approve();
  await click('Save reviewed files');
  expect(p.onSaved).not.toHaveBeenCalled();
  expect(p.onError).toHaveBeenCalledWith('Receipt readback failed');
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Close project save"]')!.disabled).toBe(
    false,
  );
  expect(button('Retry this save').disabled).toBe(false);
  await click('Reauthorize this writable folder…');
  expect(f.registerDirectory).toHaveBeenCalledWith(f.handle);
  expect(f.prepare).toHaveBeenCalledTimes(1);
  await click('Retry this save');
  expect(f.retry).toHaveBeenCalledWith('save-first-request', principal);
  expect(p.onSaved).toHaveBeenCalledTimes(1);
});
it('partial recovery reports retained new files and exposes raw download blobs only after an explicit export request', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  const proposal = await f.writer.status('save-first-request', principal);
  f.commit.mockRejectedValueOnce(
    new DirectorySaveError('partial-write', 'One file was not verified', {
      ...proposal,
      phase: 'partial',
    }),
  );
  await approve();
  await click('Save reviewed files');
  expect(f.exportRecovery).not.toHaveBeenCalled();
  await click('Recovery files');
  expect(f.exportRecovery).toHaveBeenCalledWith('save-first-request', principal);
  expect(host.querySelector('[aria-label="Recovery downloads"]')!.textContent).toContain(
    'before/Config.xml',
  );
  await click('Restore original files');
  expect(f.recover).toHaveBeenCalledWith('save-first-request', principal);
  expect(host.textContent).toContain(
    'Original bytes restored. Newly created files remain in the folder.',
  );
  expect(p.onSaved).not.toHaveBeenCalled();
});
it('a recovery record must pass the current principal status check before restoration controls become available', async () => {
  const f = fixture(),
    p = props(f),
    other = {
      id: 'other-owner',
      slot: 'right' as const,
      expectedRevision: 1,
      mode: 'save-as' as const,
      rootId: 'root-a',
      folderName: 'Other',
      phase: 'partial' as const,
      createdAt: 1,
      files: [],
      requiresOverwriteConfirmation: false,
      recoveryAvailable: true as const,
      workspaceChanged: false,
    };
  f.publish({ saves: [other] });
  f.status.mockRejectedValue(
    new DirectorySaveError('invalid-request', 'This record belongs to another owner'),
  );
  await mount(p);
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Folder recovery record"]')!;
    select.value = 'other-owner';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review recovery record');
  expect(f.status).toHaveBeenCalledWith('other-owner', principal);
  expect(host.querySelector('section[aria-label="Prepared folder save"]')).toBeNull();
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.exportRecovery).not.toHaveBeenCalled();
});
it('late chooser completion after dialog unmount cannot register a capability or launch a save', async () => {
  const f = fixture(),
    gate = deferred<WritableProjectDirectoryHandle>(),
    picker = vi.fn(() => gate.promise),
    p = props(f, { picker });
  await mount(p);
  await click('Choose parent folder…');
  await act(async () => root.render(null));
  await act(async () => gate.resolve(f.handle));
  expect(f.registerDirectory).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
});
it('a stale captured workspace revision gives a close/reopen path and never commits a newer design implicitly', async () => {
  const f = fixture(),
    p = props(f);
  f.prepare.mockRejectedValue(new DirectorySaveError('stale-workspace', 'The workspace changed.'));
  await mount(p);
  await click('Review save');
  expect(host.textContent).toContain(
    'Close this dialog and open Save again to capture the current design.',
  );
  expect(f.prepare.mock.calls[0][0]).toMatchObject({ slot: 'left', expectedRevision: 7 });
  expect(f.commit).not.toHaveBeenCalled();
  expect(p.onSaved).not.toHaveBeenCalled();
});
it('unused prepared reviews can be explicitly discarded without file recovery and a new review receives a fresh request', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  await click('Discard unused review');
  expect(f.forgetRecovery).toHaveBeenCalledWith('save-first-request', principal);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  expect(host.querySelector('section[aria-label="Prepared folder save"]')).toBeNull();
  await click('Review save');
  expect(f.prepare.mock.calls[1][0].requestId).not.toBe('first-request');
});

it('archives only after a separate review and explicit removal checkbox, once, without reporting a new project save', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  expect(button('Review archiving')).toBeUndefined();
  await approve();
  await click('Save reviewed files');
  vi.mocked(p.onSaved).mockClear();
  await click('Review archiving');
  expect(f.reviewArchive).toHaveBeenCalledWith('save-first-request', principal);
  const review = host.querySelector('[aria-label="Archive recovery review"]')!;
  expect(review.textContent).toContain('80 bytes');
  expect(review.textContent).toContain('historical receipt remains');
  expect(review.textContent).toContain('does not prove that another durable copy exists');
  expect(button('Archive recovery record').disabled).toBe(true);
  await click('Archive recovery record');
  expect(f.archive).not.toHaveBeenCalled();
  await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const confirm = button('Archive recovery record');
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(f.archive).toHaveBeenCalledTimes(1);
  expect(f.archive).toHaveBeenCalledWith('archive-save-first-request', principal, {
    confirm: true,
    removeLocalRecovery: true,
  });
  expect(p.onSaved).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Archived historical record');
  for (const label of [
    'Review archiving',
    'Restore original files',
    'Recovery files',
    'Download recovery ZIP',
    'Archive recovery record',
  ])
    expect(button(label)).toBeUndefined();
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.exportRecovery).not.toHaveBeenCalled();
});

it('incomplete saves keep recovery available but cannot offer archiving or local-copy removal', async () => {
  const f = fixture(),
    p = props(f);
  await mount(p);
  await click('Review save');
  const proposal = await f.writer.status('save-first-request', principal);
  f.commit.mockRejectedValueOnce(
    new DirectorySaveError('partial-write', 'Unconfirmed file', { ...proposal, phase: 'partial' }),
  );
  await approve();
  await click('Save reviewed files');
  expect(button('Retry this save')).toBeDefined();
  expect(button('Restore original files')).toBeDefined();
  expect(button('Download recovery ZIP')).toBeDefined();
  expect(button('Review archiving')).toBeUndefined();
  expect(host.querySelector('[aria-label="Archive recovery review"]')).toBeNull();
  expect(f.reviewArchive).not.toHaveBeenCalled();
});

it('history pages fifty records, hides archived receipts initially and reviews archived metadata without recovery controls', async () => {
  const f = fixture(),
    p = props(f),
    baseline: DirectorySaveProposal = {
      id: 'template',
      slot: 'left',
      expectedRevision: 1,
      mode: 'save-as',
      rootId: 'root-a',
      folderName: 'Folder',
      phase: 'complete',
      createdAt: 1,
      files: [],
      requiresOverwriteConfirmation: false,
      recoveryAvailable: true,
      workspaceChanged: false,
    },
    saves = Array.from({ length: 75 }, (_, index): DirectorySaveProposal => ({
      ...baseline,
      id: `history-${index}`,
      folderName: `Folder${index}`,
      ...(index >= 55 ? { archived: true, archivedAt: 1000, recoveryAvailable: false } : {}),
    }));
  f.publish({ saves });
  await mount(p);
  const select = () =>
    host.querySelector<HTMLSelectElement>('[aria-label="Folder recovery record"]')!;
  expect(select().options).toHaveLength(51);
  expect(select().textContent).not.toContain('Archived');
  expect(host.textContent).toContain('1–50 of 55');
  await click('Next records');
  expect(select().options).toHaveLength(6);
  expect(select().options[1].value).toBe('history-50');
  expect(host.textContent).toContain('51–55 of 55');
  const archivedCheckbox = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('Include archived receipts'))!
    .querySelector<HTMLInputElement>('input')!;
  await act(async () => archivedCheckbox.click());
  expect(host.textContent).toContain('1–50 of 75');
  await click('Next records');
  expect(select().options).toHaveLength(26);
  await act(async () => {
    select().value = 'history-55';
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review recovery record');
  expect(f.status).toHaveBeenCalledWith('history-55', principal);
  expect(host.textContent).toContain('Archived historical record');
  for (const label of [
    'Restore original files',
    'Recovery files',
    'Download recovery ZIP',
    'Review archiving',
  ])
    expect(button(label)).toBeUndefined();
  expect(p.onSaved).not.toHaveBeenCalled();
});

it('offers a single binary recovery ZIP only on explicit download and does not claim that download archived or backed up the record', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    p = props(f),
    createUrl = vi.fn(() => 'blob:recovery-fixture'),
    revokeUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await mount(p);
  await click('Review save');
  await approve();
  await click('Save reviewed files');
  vi.mocked(p.onSaved).mockClear();
  expect(recoveryZip.create).not.toHaveBeenCalled();
  expect(createUrl).not.toHaveBeenCalled();
  await click('Download recovery ZIP');
  expect(f.exportRecovery).toHaveBeenCalledWith('save-first-request', principal);
  expect(recoveryZip.create).toHaveBeenCalledTimes(1);
  expect(recoveryZip.create.mock.calls[0][0][0]).toMatchObject({
    path: 'before/Config.xml',
    blob: expect.any(Blob),
  });
  expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
  expect(download).toHaveBeenCalledTimes(1);
  expect((download.mock.instances[0] as HTMLAnchorElement).download).toBe(
    'Original design-recovery.zip',
  );
  expect(f.archive).not.toHaveBeenCalled();
  expect(p.onSaved).not.toHaveBeenCalled();
  await act(async () => vi.runOnlyPendingTimers());
  expect(revokeUrl).toHaveBeenCalledWith('blob:recovery-fixture');
});

const legacyUi = {
  owner: 'workspace:12345678-1234-4234-8234-123456789abc',
  scope: 'ui:captured-record-review',
};
function legacyFixture(phase: DirectorySaveProposal['phase'] = 'complete') {
  const f = fixture(),
    originalBytes = Uint8Array.of(255, 0, 13, 10),
    proposal: DirectorySaveProposal = {
      id: 'older-right-record',
      slot: 'right',
      expectedRevision: 3,
      mode: 'save-as',
      rootId: 'root-a',
      folderName: 'Earlier Right driver',
      phase,
      createdAt: 10,
      files: [
        {
          path: 'Config.xml',
          action: 'replace',
          bytes: 4,
          beforeBytes: 4,
          beforeSha256: 'b'.repeat(64),
          sha256: 'a'.repeat(64),
          state: 'verified',
          recovery: 'pending',
        },
      ],
      recoveryAvailable: true,
      needsLocalAdoption: true,
      workspaceChanged: false,
      requiresOverwriteConfirmation: false,
    },
    review: DirectoryLegacyReview = {
      id: 'older-access-review',
      recordId: proposal.id,
      slot: 'right',
      phase,
      envelopeRevision: 44,
      manifestSha256: 'd'.repeat(64),
      proposal,
    },
    reviewLegacy = vi.fn(async () => ({ ...review, id: 'fresh-older-access-review' })),
    adoptLegacy = vi.fn(async () => {
      const result = { ...proposal };
      delete result.needsLocalAdoption;
      f.publish({ saves: [result] });
      return result;
    });
  f.publish({ saves: [proposal] });
  f.writer.reviewLegacy = reviewLegacy;
  f.writer.adoptLegacy = adoptLegacy;
  const capturedProps = props(f, {
    projectName: 'Current Left design',
    captureBinding: vi.fn((): DirectorySaveBinding => ({
      slot: 'left',
      expectedRevision: 7,
      requestId: 'ui-captured',
      principal: legacyUi,
    })),
    onDownloadJson: vi.fn(),
    onDownloadZip: vi.fn(),
  });
  return { ...f, review, proposal, reviewLegacy, adoptLegacy, originalBytes, capturedProps };
}
async function allowOlderRecord() {
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(
        '[aria-label="Older record access review"] input[type="checkbox"]',
      )!
      .click(),
  );
}

it.each(['prepared', 'partial', 'complete'] as const)(
  'an external%s older-record review shows its fixed record context with no design/download/recovery mutations before approval',
  async (phase) => {
    const f = legacyFixture(phase),
      before = structuredClone(f.proposal),
      bytes = f.originalBytes.slice();
    await mount({ ...f.capturedProps, initialLegacyReview: f.review });
    expect(host.querySelector('header h2')!.textContent).toBe('Restore record access');
    expect(host.querySelector('header p')!.textContent).toBe('Right · Earlier Right driver');
    expect(host.textContent).not.toContain('Current Left design');
    expect(host.querySelector('fieldset')).toBeNull();
    expect(host.querySelector('[aria-label="Older record access review"]')!.textContent).toContain(
      'original owner, receipt and recovery bytes are preserved',
    );
    for (const label of [
      'Review save',
      'Save reviewed files',
      'Discard unused review',
      'Retry this save',
      'Restore original files',
      'Recovery files',
      'Download recovery ZIP',
      'Review archiving',
      'Download JSON',
      'Download HFD ZIP',
      'Reauthorize this writable folder…',
    ])
      expect(button(label)).toBeUndefined();
    expect(button('Confirm record access').disabled).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.exportRecovery).not.toHaveBeenCalled();
    expect(f.adoptLegacy).not.toHaveBeenCalled();
    expect(f.capturedProps.onSaved).not.toHaveBeenCalled();
    expect(f.proposal).toEqual(before);
    expect(f.originalBytes).toEqual(bytes);
  },
);

it('uses an explicit older-record review and captured UI principal for a single approval, retaining original bytes and never calling onSaved', async () => {
  const f = legacyFixture(),
    before = structuredClone(f.proposal),
    bytes = f.originalBytes.slice();
  await mount(f.capturedProps);
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Folder recovery record"]')!;
    select.value = f.proposal.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review recovery record');
  expect(host.querySelector('header p')!.textContent).toBe('Right · Earlier Right driver');
  expect(host.querySelector('fieldset')).toBeNull();
  await click('Review record access');
  expect(f.reviewLegacy).toHaveBeenCalledExactlyOnceWith(f.proposal.id, legacyUi);
  await click('Confirm record access');
  expect(f.adoptLegacy).not.toHaveBeenCalled();
  await allowOlderRecord();
  const confirm = button('Confirm record access');
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(f.adoptLegacy).toHaveBeenCalledExactlyOnceWith('fresh-older-access-review', legacyUi, {
    confirm: true,
  });
  expect(f.capturedProps.onSaved).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    'Record access restored for this workspace. Project files were not changed.',
  );
  expect(host.querySelector('[aria-label="Older record access review"]')).toBeNull();
  expect(button('Restore original files')).toBeDefined();
  expect(f.proposal).toEqual(before);
  expect(f.originalBytes).toEqual(bytes);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.exportRecovery).not.toHaveBeenCalled();
});

it('failed approval consumes the checkbox/review and requires a fresh unchecked review before another attempt', async () => {
  const f = legacyFixture();
  f.adoptLegacy.mockRejectedValueOnce(
    new DirectorySaveError('conflict', 'Older record review changed'),
  );
  await mount({ ...f.capturedProps, initialLegacyReview: f.review });
  await allowOlderRecord();
  await click('Confirm record access');
  expect(f.adoptLegacy).toHaveBeenCalledExactlyOnceWith(f.review.id, legacyUi, { confirm: true });
  expect(f.capturedProps.onError).toHaveBeenCalledWith('Older record review changed');
  expect(host.querySelector('[aria-label="Older record access review"]')).toBeNull();
  await click('Review record access');
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Older record access review"] input')!
      .checked,
  ).toBe(false);
  expect(button('Confirm record access').disabled).toBe(true);
  await click('Confirm record access');
  expect(f.adoptLegacy).toHaveBeenCalledTimes(1);
  expect(f.capturedProps.onSaved).not.toHaveBeenCalled();
});

it('a supplied external review retains its original record and UI binding when current workspace props change', async () => {
  const f = legacyFixture();
  await mount({ ...f.capturedProps, initialLegacyReview: f.review });
  await mount({
    ...f.capturedProps,
    projectName: 'Changed current design',
    captureBinding: () => ({
      slot: 'right',
      expectedRevision: 999,
      requestId: 'new',
      principal: { owner: 'workspace:other', scope: 'ui:other' },
    }),
    initialLegacyReview: {
      ...f.review,
      id: 'other-review',
      recordId: 'other-record',
      slot: 'left',
      proposal: { ...f.proposal, id: 'other-record', slot: 'left', folderName: 'Different folder' },
    },
  });
  expect(host.querySelector('header p')!.textContent).toBe('Right · Earlier Right driver');
  await allowOlderRecord();
  await click('Confirm record access');
  expect(f.adoptLegacy).toHaveBeenCalledExactlyOnceWith(f.review.id, legacyUi, { confirm: true });
  expect(f.capturedProps.captureBinding).toHaveBeenCalledTimes(1);
});
