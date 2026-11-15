import type { Project } from './model';
import { exportHfd } from './files';
import { projectFiles, type ProjectFile } from './project-io';
import {
  nativeCloneTemplateSchema,
  parseNativeCloneInfo,
  replaceNativeCloneInfo,
  type NativeCloneTemplate,
} from './clone-template';

/** Legacy browser JSON can contain native info in sourceXml without the new
 * typed marker. Reading it here is explicit and does not mutate the design. */
export function requireNativeCloneTemplate(project: Project): NativeCloneTemplate {
  const candidate =
    project.hfdCloneTemplate ??
    (project.sourceXml ? parseNativeCloneInfo(project.sourceXml) : undefined);
  if (!candidate) throw new Error('This design has no saved amplifier template');
  const template = nativeCloneTemplateSchema.parse(candidate);
  // Invalid native configuration can still be inspected/exported. Programming
  // validity belongs to buildClonePlan, never to serialization of captured facts.
  return structuredClone(template);
}

/** Explicit native Clone export: filters come from the current design; device
 * settings and all three physical EQ banks come from its captured template. */
export function exportNativeCloneProject(project: Project): string {
  return replaceNativeCloneInfo(exportHfd(project), requireNativeCloneTemplate(project));
}

/** Keep all measurement/calibration resources and the ordinary lossless browser
 * sidecar. Rebind that sidecar to the actual emitted Clone Config.xml rather
 * than hiding a changed native file behind the ordinary design export. */
export function nativeCloneProjectFiles(project: Project): ProjectFile[] {
  const template = requireNativeCloneTemplate(project),
    exported = { ...project, hfdCloneTemplate: template },
    files = projectFiles(exported),
    config = files.find((file) => file.path === 'Config.xml'),
    browser = files.find((file) => file.path === 'FusionProject.json');
  if (!config || !browser) throw new Error('The native project export is incomplete');
  config.content = replaceNativeCloneInfo(config.content, template);
  const sidecar = JSON.parse(browser.content) as Record<string, unknown>;
  sidecar.nativeFiles = files.filter((file) => file !== browser);
  browser.content = JSON.stringify(sidecar, null, 2);
  return files;
}
