import {
  createProjectSources,
  type ProjectSourcesOptions,
  type ProjectSources,
  type ProjectOpenReceipt,
} from './project-sources';
import { useWorkspace } from '../state/workspace';
import { getProject, type SavedProject } from '../hardware/storage';
import { parseExecutionPrincipal, type ExecutionPrincipal } from './execution-context';
import type { FileCommitReceipt } from '../state/persistence';

export interface WorkspaceProjectSourcesOptions extends Pick<
  ProjectSourcesOptions,
  'backend' | 'compareNames' | 'now' | 'id'
> {
  getWorkspace?: () => Pick<
    ReturnType<typeof useWorkspace.getState>,
    'commitFileImport' | 'lookupFileCommit'
  >;
  getLibraryProject?: (id: string) => Promise<SavedProject | undefined>;
}
function publicReceipt(
  receipt: FileCommitReceipt,
  principal: Readonly<ExecutionPrincipal>,
): ProjectOpenReceipt {
  const recorded = parseExecutionPrincipal({ owner: receipt.owner, scope: receipt.scope });
  if (recorded.owner !== principal.owner)
    throw new Error('The durable open receipt belongs to another owner');
  // Explicit same-owner request-ID recovery is allowed after a lease/page reload.
  // Scope is validated but need not equal the new scope. No file bytes are returned.
  return {
    commitId: receipt.commitId,
    revision: receipt.revision,
    result: structuredClone(receipt.result),
  };
}
/** No hydration, permission requests or file reads happen during construction. */
export function createWorkspaceProjectSources(
  options: WorkspaceProjectSourcesOptions = {},
): ProjectSources {
  const workspace = options.getWorkspace ?? useWorkspace.getState;
  const library = options.getLibraryProject ?? getProject;
  return createProjectSources({
    backend: options.backend,
    compareNames: options.compareNames,
    now: options.now,
    id: options.id,
    async resolveLibrary(id) {
      const record = await library(id);
      return record && !record.trashed ? record.project : undefined;
    },
    async lookup(commitId, principal) {
      const receipt = await workspace().lookupFileCommit(commitId, principal.owner);
      return receipt ? publicReceipt(receipt, principal) : undefined;
    },
    async commit(binding, project, commitId, result) {
      const slots = binding.target === 'both' ? (['left', 'right'] as const) : [binding.target];
      const receipt = await workspace().commitFileImport(
        commitId,
        binding.principal,
        binding.expectedRevision,
        [...slots],
        (destination) => {
          // Full import replacement must remove optional keys absent from the source.
          for (const key of Object.keys(destination))
            delete (destination as unknown as Record<string, unknown>)[key];
          Object.assign(destination, structuredClone(project));
        },
        { ...result },
        undefined,
        { synchronizeLinks: false },
      );
      return publicReceipt(receipt, binding.principal);
    },
  });
}
