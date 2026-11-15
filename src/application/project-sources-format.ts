import { z } from 'zod';
import { assertDirectoryEntryName, isProjectDirectoryHandle } from './directory-project-source';
import type { ProjectSourcesEnvelope, ProjectDirectoryHandle } from './project-sources';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(65536);
const reference = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('directory-project'),
      rootId: id,
      folderName: z.string().min(1).max(65536),
    })
    .strict(),
  z.object({ kind: z.literal('library-snapshot'), libraryId: id }).strict(),
]);
const schema = z
  .object({
    version: z.literal(1),
    revision: time,
    roots: z
      .array(
        z
          .object({ id, label, handle: z.custom<ProjectDirectoryHandle>(isProjectDirectoryHandle) })
          .strict(),
      )
      .max(32),
    sources: z
      .array(z.object({ id, source: reference, label, modifiedAt: time.optional() }).strict())
      .max(10000),
    recent: z.array(z.object({ sourceId: id, openedAt: time }).strict()).max(10),
    activeRootId: id.optional(),
    sort: z
      .object({ by: z.enum(['name', 'modified']), direction: z.enum(['ascending', 'descending']) })
      .strict()
      .optional(),
  })
  .strict();
export function parseProjectSourcesEnvelope(value: unknown): ProjectSourcesEnvelope {
  const parsed = schema.parse(value);
  for (const root of parsed.roots) assertDirectoryEntryName(root.handle.name);
  const roots = parsed.roots.map(({ id }) => id),
    sources = parsed.sources.map(({ id }) => id);
  if (
    new Set(roots).size !== roots.length ||
    new Set(sources).size !== sources.length ||
    new Set(parsed.recent.map(({ sourceId }) => sourceId)).size !== parsed.recent.length
  )
    throw new Error('Duplicate project-source identifiers');
  if (parsed.activeRootId !== undefined && !roots.includes(parsed.activeRootId))
    throw new Error('Selected database source is missing');
  const references = parsed.sources.map(({ source }) => JSON.stringify(source));
  if (new Set(references).size !== references.length)
    throw new Error('Duplicate project-source references');
  for (const entry of parsed.sources)
    if (entry.source.kind === 'directory-project')
      assertDirectoryEntryName(entry.source.folderName);
  if (parsed.recent.some(({ sourceId }) => !sources.includes(sourceId)))
    throw new Error('Recent project source is missing');
  return parsed;
}
/** Deliberately excludes capability objects from JSON; those never enter transcripts. */
export function projectSourcesMetadata(value: ProjectSourcesEnvelope): string {
  return JSON.stringify({ ...value, roots: value.roots.map(({ id, label }) => ({ id, label })) });
}
export function assertProjectSourcesWrite(
  current: unknown | null,
  next: ProjectSourcesEnvelope,
  expectedRevision: number | null,
): void {
  const checked = parseProjectSourcesEnvelope(next);
  const existing = current === null ? null : parseProjectSourcesEnvelope(current);
  if (
    existing &&
    existing.revision === checked.revision &&
    projectSourcesMetadata(existing) === projectSourcesMetadata(checked)
  )
    return;
  if (
    (existing?.revision ?? null) !== expectedRevision ||
    checked.revision !== (expectedRevision ?? 0) + 1
  )
    throw new Error('Project sources changed in another tab; retry before making changes');
}
