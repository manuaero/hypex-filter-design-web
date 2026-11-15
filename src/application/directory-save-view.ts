import type { DirectorySaveProposal, DirectoryWriterSnapshot } from './project-directory-writer';

function page(offset = 0, limit = 40) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Invalid directory-save page');
  return { offset, limit };
}
/** Recovery manifests can contain thousands of files; agent replies stay paged. */
export function directoryProposalPage<T extends DirectorySaveProposal>(
  value: T,
  options: { fileOffset?: number; fileLimit?: number } = {},
) {
  const { offset, limit } = page(options.fileOffset, options.fileLimit);
  return {
    ...value,
    files: value.files.slice(offset, offset + limit),
    ...('introduced' in value && Array.isArray(value.introduced)
      ? {
          introduced: value.introduced.slice(offset, offset + limit),
          totalIntroduced: value.introduced.length,
        }
      : {}),
    ...('restored' in value && Array.isArray(value.restored)
      ? {
          restored: value.restored.slice(offset, offset + limit),
          totalRestored: value.restored.length,
        }
      : {}),
    totalFiles: value.files.length,
    fileOffset: offset,
    nextFileOffset: offset + limit < value.files.length ? offset + limit : null,
  };
}
/** The browser retains its full metadata history; views expose bounded pages. */
export function directorySnapshotPage(
  value: DirectoryWriterSnapshot,
  options: { offset?: number; limit?: number; includeArchived?: boolean } = {},
) {
  const { offset, limit } = page(options.offset, options.limit ?? 20);
  const isArchived = (save: DirectorySaveProposal) => 'archived' in save && save.archived === true;
  const saves = value.saves.filter((save) => options.includeArchived || !isArchived(save));
  return {
    ...value,
    saves: saves.slice(offset, offset + limit).map((save) => directoryProposalPage(save)),
    totalSaves: saves.length,
    archivedSaves: value.saves.filter(isArchived).length,
    offset,
    nextOffset: offset + limit < saves.length ? offset + limit : null,
  };
}
