import { z } from 'zod';
import { newProject, type Project, type Slot, type Measurement } from '../domain/model';
import { editPresetFir } from '../domain/fir-editing';
import {
  parseProject,
  parseFir,
  parseMeasurement,
  exportHfd,
  projectSchema,
} from '../domain/files';
import { importProjectFolder, projectFiles } from '../domain/project-io';
import { exportNativeCloneProject, nativeCloneProjectFiles } from '../domain/clone-project';
import { parseImpulse, decodeWav, spectrum } from '../domain/measurement';
import {
  importChannelMeasurement,
  processChannelMeasurement,
  reconcileProjectHfdCalibration,
} from '../domain/hfd-measurement';
import { loadProjectMicrophone, setProjectMicrophoneOptions } from '../domain/hfd-microphone';
import { rootChannel, synchronizeLinks } from '../domain/links';
import { listBackups, listFirBackups, listConfigurationBackups } from '../hardware/storage';
import {
  FILE_TRANSFER_MAX_FILE_BYTES,
  type TransferBinding,
  type TransferBlobFile,
  type TransferJson,
} from './file-transfers';
import { assertFileByteBudget, readFileText, MAX_UI_TEXT_CHARACTERS } from './file-budget';

const target = z.enum(['left', 'right', 'both']);
const slot = z.enum(['left', 'right']);
const preset = z.number().int().min(1).max(3);
const channel = z.number().int().min(1).max(3);
const name = z.string().optional();
const measurementTarget = {
  target,
  preset,
  channel,
  name,
  analysis: z.enum(['browser', 'hfd']).optional(),
};
const selection = { slot, preset, channel };
const variant = <W extends string, P extends z.ZodRawShape>(workflow: W, parameters: P) =>
  z.object({ workflow: z.literal(workflow), parameters: z.object(parameters).strict() }).strict();

/** These offline workflows cannot select an amplifier or perform a device write. */
export const ImportWorkflowSchema = z.discriminatedUnion('workflow', [
  variant('project', { target, name: z.string().max(200).optional() }),
  variant('folder', { target, name: z.string().max(200).optional() }),
  variant('fir', {
    target,
    preset,
    channel: z.number().int().min(0).max(3),
    name,
    enabled: z.boolean().optional(),
  }),
  variant('measurement-text', {
    ...measurementTarget,
    sampleRate: z.number().finite().min(8000).max(384000).default(48000),
    format: z.enum(['auto', 'impulse', 'frequency']).default('auto'),
  }),
  variant('measurement-wav', measurementTarget),
  variant('microphone', {
    target,
    name,
    showCurve: z.boolean().optional(),
    smoothingOctaves: z.number().finite().min(0).max(3).optional(),
  }),
  variant('calibration', { target, preset, channel, name }),
]);
export const ExportWorkflowSchema = z.discriminatedUnion('workflow', [
  variant('project-json', { slot }),
  variant('project-hfd-xml', { slot }),
  variant('project-folder', { slot }),
  variant('project-clone-hfd-xml', { slot }),
  variant('project-clone-folder', { slot }),
  variant('measurement-frequency', selection),
  variant('measurement-impulse', selection),
  variant('fir', { slot, preset, channel: z.number().int().min(0).max(3) }),
  variant('backup', { backupId: z.string().min(1) }),
  variant('fir-backup', { backupId: z.string().min(1) }),
  variant('configuration-backup', { backupId: z.string().min(1) }),
  variant('workspace-recovery', {}),
]);
export const importWorkflowSchema = ImportWorkflowSchema;
export const exportWorkflowSchema = ExportWorkflowSchema;
export type ImportWorkflow = z.infer<typeof ImportWorkflowSchema>;
export type ExportWorkflow = z.infer<typeof ExportWorkflowSchema>;
export interface PreparedFileImport {
  slots: Slot[];
  /** Full replacements retain source channel state exactly; ordinary edits use normal links. */
  synchronizeLinks?: boolean;
  /** Atomically validates one detached proposal; the caller commits all roles together. */
  apply: (project: Project) => void;
  /** After application, remember only a native target's resulting project resource. */
  remember?: 'microphone';
  result: TransferJson;
}
export interface FileExportSnapshot {
  documents: Record<Slot, Project>;
}

const roles = (value: 'left' | 'right' | 'both'): Slot[] =>
  value === 'both' ? ['left', 'right'] : [value];
function replaceProject(target: Project, replacement: Project) {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, structuredClone(replacement));
}
function atomic(
  change: (project: Project) => void,
  options?: { synchronizeLinks?: boolean },
): (project: Project) => void {
  return (project) => {
    const proposed = structuredClone(project);
    change(proposed);
    if (options?.synchronizeLinks !== false) synchronizeLinks(proposed, project);
    else
      for (const preset of proposed.presets)
        preset.channels.forEach((_, index) => rootChannel(preset, index));
    reconcileProjectHfdCalibration(proposed, project);
    projectSchema.parse(proposed);
    replaceProject(project, proposed);
  };
}
function checkedFiles(files: readonly TransferBlobFile[]): TransferBlobFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2000)
    throw new Error('File workflow requires 1–2000 files');
  assertFileByteBudget(files.map((file) => ({ size: file?.blob?.size })));
  const seen = new Set<string>();
  return files.map((file) => {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      new TextEncoder().encode(file.path).byteLength > 1024 ||
      /[\u0000-\u001f\u007f:]/.test(file.path) ||
      /(^|[\\/])(?:\.|\.\.)([\\/]|$)|^[\\/]/.test(file.path) ||
      !(file.blob instanceof Blob) ||
      file.blob.size > FILE_TRANSFER_MAX_FILE_BYTES
    )
      throw new Error('Invalid workflow file path or file byte budget');
    const path = file.path.replaceAll('\\', '/'),
      key = path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate workflow file path');
    seen.add(key);
    return { path, blob: file.blob };
  });
}
async function textFile(file: TransferBlobFile, limit: number, label: string, preserveBom = false) {
  try {
    return await readFileText(file.blob, limit, { preserveBom });
  } catch (error) {
    throw new Error(
      `${label} text import limit/read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Parse uploaded bytes before any document mutation. No USB or persistence write occurs here. */
export async function prepareFileImport(
  binding: TransferBinding,
  incoming: readonly TransferBlobFile[],
): Promise<PreparedFileImport> {
  if (!Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 0)
    throw new Error('Invalid expected workspace revision');
  const workflow = ImportWorkflowSchema.parse({
    workflow: binding.workflow,
    parameters: binding.parameters,
  });
  const files = checkedFiles(incoming);
  if (workflow.workflow !== 'folder' && files.length !== 1)
    throw new Error('This import workflow requires exactly one file');
  const params = workflow.parameters;
  const slots = roles(params.target);
  const filename =
    ('name' in params ? params.name : undefined) ??
    (workflow.workflow === 'folder' ? files[0].path : files[0].path.split('/').at(-1)!);
  const result: TransferJson = {
    ok: true,
    workflow: workflow.workflow,
    fileCount: files.length,
    filesPreview: files.slice(0, 10).map((f) => f.path),
    omittedCount: Math.max(0, files.length - 10),
    slots,
  };
  if (workflow.workflow === 'project' || workflow.workflow === 'folder') {
    let project: Project;
    if (workflow.workflow === 'project')
      project = parseProject(await textFile(files[0], MAX_UI_TEXT_CHARACTERS, 'Project'), filename);
    else {
      const decoded = [];
      let characters = 0;
      for (const file of files) {
        const content = await textFile(
          file,
          MAX_UI_TEXT_CHARACTERS,
          'Folder file',
          !/\.json$/i.test(file.path),
        );
        characters += content.length;
        if (characters > 80e6) throw new Error('Project folder exceeds import limits');
        decoded.push({ path: file.path, content });
      }
      project = importProjectFolder(decoded, filename);
    }
    const frozen = structuredClone(project);
    return {
      slots,
      synchronizeLinks: false,
      apply: atomic((target) => replaceProject(target, frozen), { synchronizeLinks: false }),
      result: {
        ...result,
        warnings: project.warnings.slice(0, 10).map((warning) => warning.slice(0, 512)),
        warningCount: project.warnings.length,
        omittedWarningCount: Math.max(0, project.warnings.length - 10),
      },
    };
  }
  if (workflow.workflow === 'fir') {
    const p = workflow.parameters;
    const taps = parseFir(
      await textFile(files[0], MAX_UI_TEXT_CHARACTERS, 'FIR'),
      p.channel === 0 ? 4500 : 1500,
    );
    return {
      slots,
      result,
      apply: atomic((project) => {
        editPresetFir(project.presets[p.preset - 1], p.channel, {
          name: filename,
          taps,
          ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
        });
      }),
    };
  }
  if (workflow.workflow === 'measurement-text' || workflow.workflow === 'measurement-wav') {
    const p = workflow.parameters;
    result.preset = p.preset;
    result.channel = p.channel;
    let measurement: Measurement;
    if (workflow.workflow === 'measurement-wav')
      measurement = decodeWav(await files[0].blob.arrayBuffer(), filename);
    else {
      const text = await textFile(files[0], MAX_UI_TEXT_CHARACTERS, 'Measurement');
      const p = workflow.parameters;
      measurement =
        p.format === 'impulse'
          ? parseImpulse(text, filename, p.sampleRate)
          : parseMeasurement(text, filename);
      if (p.format === 'frequency' && measurement.impulse)
        throw new Error('Frequency import requires frequency/dB columns, not impulse samples');
      if (measurement.impulse && measurement.sampleRate !== p.sampleRate)
        Object.assign(measurement, spectrum(measurement.impulse, p.sampleRate));
    }
    return {
      slots,
      result,
      apply: atomic((project) => {
        importChannelMeasurement(
          project.presets[p.preset - 1].channels[p.channel - 1],
          measurement,
          p.analysis,
        );
      }),
    };
  }
  if (workflow.workflow === 'microphone') {
    const text = await textFile(files[0], 20e6, 'Microphone');
    const p = workflow.parameters;
    // Parse immediately on an isolated document, so malformed resources fail
    // before the caller even begins proposing paired document changes.
    const probe = newProject();
    loadProjectMicrophone(probe, text, filename);
    return {
      slots,
      result,
      remember: 'microphone',
      apply: atomic((project) => {
        loadProjectMicrophone(project, text, filename);
        if (p.showCurve !== undefined || p.smoothingOctaves !== undefined)
          setProjectMicrophoneOptions(project, {
            ...(p.showCurve === undefined ? {} : { showCurve: p.showCurve }),
            ...(p.smoothingOctaves === undefined ? {} : { smoothingOctaves: p.smoothingOctaves }),
          });
      }),
    };
  }
  const p = workflow.parameters;
  const text = await textFile(files[0], MAX_UI_TEXT_CHARACTERS, 'Calibration');
  return {
    slots,
    result,
    remember: 'microphone',
    apply: atomic((project) => {
      const c = project.presets[p.preset - 1].channels[p.channel - 1];
      if (!c.measurement) throw new Error('No measurement loaded');
      if (c.hfdMeasurement) {
        loadProjectMicrophone(project, text, filename);
        project.presets[p.preset - 1].channels[p.channel - 1].hfdMeasurement!.applyMicCorrection =
          true;
      } else {
        const cal = parseMeasurement(text, filename);
        if (!cal.frequency?.length || !cal.magnitude?.length)
          throw new Error('Load a frequency/dB correction file');
        processChannelMeasurement(c, {
          calibration: {
            name: cal.name,
            sampleRate: cal.sampleRate,
            frequency: cal.frequency,
            magnitude: cal.magnitude,
            phase: cal.phase,
          },
          calibrationEnabled: true,
        });
      }
    }),
  };
}

function filenamePart(value: string, fallback: string) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f\\/:]/g, '_');
  let result = '',
    bytes = 0;
  for (const character of cleaned) {
    bytes += new TextEncoder().encode(character).length;
    if (bytes > 900) break;
    result += character;
  }
  return result && !/^\.+$/.test(result) ? result : fallback;
}
/** Buffered pretty JSON avoids creating one giant project string. */
function jsonBlob(value: unknown): Blob {
  const ancestors = new WeakSet<object>();
  function* tokens(item: unknown, depth: number): Generator<string> {
    if (item === null || typeof item !== 'object') {
      yield JSON.stringify(item) ?? 'null';
      return;
    }
    if (ancestors.has(item)) throw new Error('Cannot export cyclic JSON data');
    ancestors.add(item);
    const array = Array.isArray(item);
    const entries = array ? null : Object.entries(item).filter(([, value]) => value !== undefined);
    const count = array ? item.length : entries!.length;
    yield array ? '[' : '{';
    for (let i = 0; i < count; i++) {
      const [key, value] = array ? [String(i), item[i]] : entries![i];
      yield (i ? ',\n' : '\n') + '  '.repeat(depth + 1);
      if (!array) yield JSON.stringify(key) + ': ';
      yield* tokens(value, depth + 1);
    }
    if (count) yield '\n' + '  '.repeat(depth);
    yield array ? ']' : '}';
    ancestors.delete(item);
  }
  const parts: string[] = [];
  let buffer = '';
  let bytes = 0;
  const append = (part: string) => {
    bytes += new TextEncoder().encode(part).length;
    if (bytes > FILE_TRANSFER_MAX_FILE_BYTES) throw new Error('Export exceeds file byte budget');
    parts.push(part);
  };
  for (const token of tokens(value, 0)) {
    if (buffer.length + token.length > 65536) {
      if (buffer) append(buffer);
      buffer = '';
    }
    if (token.length > 65536) append(token);
    else buffer += token;
  }
  if (buffer) append(buffer);
  return new Blob(parts, { type: 'application/json' });
}
function linesBlob(count: number, line: (index: number) => string): Blob {
  const parts: string[] = [];
  let buffer = '';
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    buffer += (i ? '\n' : '') + line(i);
    if (buffer.length >= 65536) {
      bytes += new TextEncoder().encode(buffer).length;
      if (bytes > FILE_TRANSFER_MAX_FILE_BYTES) throw new Error('Export exceeds file byte budget');
      parts.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    bytes += new TextEncoder().encode(buffer).length;
    if (bytes > FILE_TRANSFER_MAX_FILE_BYTES) throw new Error('Export exceeds file byte budget');
    parts.push(buffer);
  }
  return new Blob(parts, { type: 'text/plain' });
}

/** Capture exports in browser-owned Blobs. Backup reads never access an amplifier. */
export async function prepareFileExport(
  input: unknown,
  snapshot: FileExportSnapshot,
  recovery: string | null = null,
): Promise<TransferBlobFile[]> {
  const request = ExportWorkflowSchema.parse(input);
  let files: TransferBlobFile[];
  if (request.workflow === 'workspace-recovery') {
    if (recovery === null) throw new Error('Workspace recovery export is unavailable');
    files = [
      {
        path: 'fusion-workspace-recovery.json',
        blob: new Blob([recovery], { type: 'application/json' }),
      },
    ];
  } else if (
    request.workflow === 'backup' ||
    request.workflow === 'fir-backup' ||
    request.workflow === 'configuration-backup'
  ) {
    const id = request.parameters.backupId;
    const records =
      request.workflow === 'backup'
        ? await listBackups()
        : request.workflow === 'fir-backup'
          ? await listFirBackups()
          : await listConfigurationBackups();
    const found = records.find((record) => record.id === id);
    if (!found) throw new Error('Saved recovery image not found');
    const record = structuredClone(found);
    const path =
      request.workflow === 'backup'
        ? `FA503-p${'preset' in record ? record.preset : ''}-${filenamePart(record.utc.replace(/[:.]/g, '-'), 'recovery')}.backup.json`
        : request.workflow === 'fir-backup'
          ? `FIR-p${'preset' in record ? record.preset : ''}-${filenamePart(record.id, 'recovery')}.json`
          : `FA503-configuration-${filenamePart(record.id, 'recovery')}.json`;
    files = [{ path, blob: jsonBlob(record) }];
  } else {
    const p = request.parameters;
    const project = structuredClone(snapshot.documents[p.slot]);
    // Validate without reordering keys: the native-folder sidecar must contain
    // the exact JSON/text that the existing UI exporter emits for this snapshot.
    projectSchema.parse(project);
    if (request.workflow === 'project-json')
      files = [
        { path: `${filenamePart(project.name, 'project')}.fusion.json`, blob: jsonBlob(project) },
      ];
    else if (request.workflow === 'project-hfd-xml')
      files = [
        {
          path: `${filenamePart(project.name, 'project')}-edited.xml`,
          blob: new Blob([exportHfd(project)], { type: 'application/xml' }),
        },
      ];
    else if (request.workflow === 'project-clone-hfd-xml')
      files = [
        {
          path: `${filenamePart(project.name, 'project')}-clone.xml`,
          blob: new Blob([exportNativeCloneProject(project)], { type: 'application/xml' }),
        },
      ];
    else if (request.workflow === 'project-clone-folder')
      files = nativeCloneProjectFiles(project).map((file) => ({
        path: file.path,
        blob: new Blob([file.content], {
          type: /\.xml$/i.test(file.path)
            ? 'application/xml'
            : /\.json$/i.test(file.path)
              ? 'application/json'
              : 'text/plain',
        }),
      }));
    else if (request.workflow === 'project-folder')
      files = projectFiles(project).map((file) => ({
        path: file.path,
        blob: new Blob([file.content], {
          type: /\.xml$/i.test(file.path)
            ? 'application/xml'
            : /\.json$/i.test(file.path)
              ? 'application/json'
              : 'text/plain',
        }),
      }));
    else if (request.workflow === 'fir') {
      const p = request.parameters,
        pr = project.presets[p.preset - 1];
      const f = p.channel === 0 ? pr.inputFir : pr.channels[p.channel - 1].fir;
      if (!f.taps.length) throw new Error('No FIR taps loaded');
      files = [
        {
          path: `${filenamePart(f.name, 'fir')}.txt`,
          blob: linesBlob(f.taps.length, (i) => String(f.taps[i])),
        },
      ];
    } else {
      const p = request.parameters;
      const m = project.presets[p.preset - 1].channels[p.channel - 1].measurement;
      if (!m) throw new Error('No measurement loaded');
      if (request.workflow === 'measurement-impulse') {
        if (!m.impulse?.length) throw new Error('No impulse samples available');
        files = [
          {
            path: `${filenamePart(m.name, 'measurement')}.dat`,
            blob: linesBlob(m.impulse.length, (i) => String(m.impulse![i])),
          },
        ];
      } else {
        if (!m.frequency?.length) throw new Error('No frequency response available');
        files = [
          {
            path: `${filenamePart(m.name, 'measurement')}.frd`,
            blob: linesBlob(m.frequency.length, (i) =>
              [m.frequency![i], m.magnitude?.[i] ?? 0, m.phase?.[i] ?? 0].join('\t'),
            ),
          },
        ];
      }
    }
  }
  return checkedFiles(files);
}
