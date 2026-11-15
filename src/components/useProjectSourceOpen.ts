'use client';
import { useCallback, useRef, useState } from 'react';
import {
  ProjectSourcesError,
  type ProjectOpenBinding,
  type ProjectOpenResult,
  type ProjectSources,
} from '../application/project-sources';

export type ProjectSourceOpenInput = ProjectOpenBinding & { sourceId: string };
export interface ProjectSourceOpener {
  pending?: Readonly<ProjectSourceOpenInput>;
  busy: boolean;
  /** Read synchronously in shared MCP callbacks, without waiting for React to render. */
  getStatus(): { pending?: Readonly<ProjectSourceOpenInput>; busy: boolean };
  open(input: ProjectSourceOpenInput): Promise<ProjectOpenResult>;
  retry(): Promise<ProjectOpenResult>;
  /** Clears retry metadata only. It cannot cancel an active open or undo a design. */
  discard(): void;
}
const knownBeforeApply = new Set<ProjectSourcesError['code']>([
  'missing-source',
  'invalid-project',
  'needs-human-grant',
  'source-changed',
]);
function capture(input: ProjectSourceOpenInput): Readonly<ProjectSourceOpenInput> {
  return Object.freeze({
    sourceId: input.sourceId,
    target: input.target,
    expectedRevision: input.expectedRevision,
    requestId: input.requestId,
    principal: Object.freeze({ owner: input.principal.owner, scope: input.principal.scope }),
  });
}
/** A shared human open/retry coordinator; durable deduplication stays in the source service. */
export function useProjectSourceOpen(sources: ProjectSources): ProjectSourceOpener {
  const [state, setState] = useState<Pick<ProjectSourceOpener, 'pending' | 'busy'>>({
    busy: false,
  });
  const job = useRef<
    { input: Readonly<ProjectSourceOpenInput>; sources: ProjectSources } | undefined
  >(undefined);
  const running = useRef(false);
  const run = useCallback(
    async (operation: NonNullable<typeof job.current>): Promise<ProjectOpenResult> => {
      running.current = true;
      setState({ pending: operation.input, busy: true });
      try {
        const result = await operation.sources.open(operation.input);
        if (job.current === operation) job.current = undefined;
        return result;
      } catch (error) {
        if (
          job.current === operation &&
          error instanceof ProjectSourcesError &&
          knownBeforeApply.has(error.code)
        )
          job.current = undefined;
        // commit-failed, persistence and unknown failures can follow an in-memory
        // document application. Keep the exact original request for receipt recovery.
        throw error;
      } finally {
        running.current = false;
        setState({ pending: job.current?.input, busy: false });
      }
    },
    [],
  );
  const open = useCallback(
    async (input: ProjectSourceOpenInput) => {
      if (running.current) throw new Error('A project open is already running');
      if (job.current)
        throw new Error(
          'Retry or discard the unconfirmed project open before opening another project',
        );
      const operation = { input: capture(input), sources };
      // Lock synchronously before run invokes any asynchronous source operation.
      job.current = operation;
      return run(operation);
    },
    [sources, run],
  );
  const retry = useCallback(async () => {
    if (running.current) throw new Error('A project open is already running');
    if (!job.current) throw new Error('There is no unconfirmed project open to retry');
    return run(job.current);
  }, [run]);
  const discard = useCallback(() => {
    if (running.current)
      throw new Error('Wait for the project open to finish before discarding its retry');
    job.current = undefined;
    setState({ busy: false });
  }, []);
  const getStatus = useCallback(() => ({ pending: job.current?.input, busy: running.current }), []);
  return { ...state, getStatus, open, retry, discard };
}
