import type { Project, Slot } from '../domain/model';
import { nativeCloneTemplateSchema, type NativeCloneTemplate } from '../domain/clone-template';
import { requireNativeCloneTemplate } from '../domain/clone-project';

interface WorkspacePort {
  state(): { documents: Record<Slot, Project>; documentRevision?: number };
  edit(
    slots: Slot[],
    change: (project: Project) => void,
    options: { synchronizeLinks: false },
  ): void;
}

/** Stable read-only legacy projection and a single atomic metadata replacement for paired Reload. */
export function createCloneWorkspace(port: WorkspacePort) {
  const projections = new WeakMap<Project, Project>();
  const versions: Record<Slot, { signature: string; revision: number }> = {
    left: { signature: '', revision: 0 },
    right: { signature: '', revision: 0 },
  };
  return {
    design(slot: Slot) {
      const state = port.state(),
        source = state.documents[slot];
      let project = projections.get(source);
      if (!project) {
        project = source;
        if (!source.hfdCloneTemplate && source.sourceXml) {
          try {
            project = { ...source, hfdCloneTemplate: requireNativeCloneTemplate(source) };
          } catch {
            // Designs without a complete physical snapshot remain usable for filter editing.
            // Clone's schema and valid checks reject them before any hardware write.
          }
        }
        projections.set(source, project);
      }
      const signature = JSON.stringify(project.hfdCloneTemplate ?? null),
        version = versions[slot];
      if (signature !== version.signature) {
        version.signature = signature;
        version.revision++;
      }
      return {
        project,
        documentRevision: state.documentRevision ?? 0,
        templateRevision: version.revision,
      };
    },
    replaceTemplates(
      entries: readonly { slot: Slot; template: NativeCloneTemplate }[],
      expectedDocumentRevision: number,
    ) {
      if (
        !Number.isSafeInteger(expectedDocumentRevision) ||
        expectedDocumentRevision < 0 ||
        (port.state().documentRevision ?? 0) !== expectedDocumentRevision
      )
        throw new Error('The design changed during device capture; Reload again');
      if (
        !entries.length ||
        entries.length > 2 ||
        new Set(entries.map((e) => e.slot)).size !== entries.length ||
        entries.some((e) => e.slot !== 'left' && e.slot !== 'right')
      )
        throw new Error('Reload requires unique explicit design roles');
      const prepared = entries.map((entry) => ({
        slot: entry.slot,
        template: nativeCloneTemplateSchema.parse(entry.template),
      }));
      let index = 0;
      port.edit(
        prepared.map((entry) => entry.slot),
        (project) => {
          project.hfdCloneTemplate = structuredClone(prepared[index++].template);
        },
        { synchronizeLinks: false },
      );
    },
  };
}
