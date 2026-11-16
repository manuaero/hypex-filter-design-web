import { parseProject } from './files';
import type { Project } from './model';

export type ProjectOpenFormat = 'hfd-native' | 'browser-snapshot';

export interface DecodedProjectOpen {
  project: Project;
  format: ProjectOpenFormat;
}

/** Decode the actual input without applying native FileOpen or browser view effects. */
export function parseProjectOpen(text: string, name?: string): DecodedProjectOpen {
  const project = parseProject(text, name);
  return {
    project,
    format: text.trimStart().startsWith('<') ? 'hfd-native' : 'browser-snapshot',
  };
}
