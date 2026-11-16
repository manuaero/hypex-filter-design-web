import { type Project } from './model';
import { parseProjectOpen, type DecodedProjectOpen } from './project-open';
import { downloadBrowserBlob } from './browser-download';
import { exportHfd, projectSchema, UNRESOLVED_HFD_CALIBRATION_WARNING } from './files';
import { parseImpulse } from './measurement';
import { recomputeHfdMeasurement, reconcileProjectHfdCalibration } from './hfd-measurement';
import { parseHfdCalibration } from './hfd-calibration';
import { z } from 'zod';
export interface ProjectFile {
  path: string;
  content: string;
}
const sidecarSchema = z
  .object({
    format: z.literal('fusion-studio-hfd-folder'),
    version: z.union([z.literal(1), z.literal(2)]),
    nativeFiles: z
      .array(z.object({ path: z.string(), content: z.string() }).strict())
      .min(1)
      .max(2000),
    project: projectSchema,
  })
  .strict();
const normalized = (path: string) => path.replaceAll('\\', '/').toLowerCase();
const nativeFile = (path: string) => /\.(xml|dat|txt|frd)$/i.test(path);
const unsafePath = (path: string) => /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(path);

function restoreSidecar(
  files: ProjectFile[],
  base: string,
  nativeProject: Project,
): Project | undefined {
  const warnings = nativeProject.warnings;
  const candidates = files.filter(
    (f) => normalized(f.path) === normalized(base + 'FusionProject.json'),
  );
  if (!candidates.length) return;
  const ignore = (reason: string) => {
    warnings.push(`Ignored FusionProject.json: ${reason}; using native Config.xml/DAT files.`);
  };
  if (candidates.length !== 1) {
    ignore('multiple browser sidecars');
    return;
  }
  let sidecar: z.infer<typeof sidecarSchema>;
  try {
    const value = JSON.parse(candidates[0].content);
    if (value?.format === 'fusion-studio-project') {
      ignore('legacy browser sidecar has no native-file snapshot');
      return;
    }
    sidecar = sidecarSchema.parse(value);
    const key =
      sidecar.version === 2 ? (path: string) => normalized(path).normalize('NFC') : normalized;
    const paths = sidecar.nativeFiles.map((f) => key(f.path));
    if (
      !paths.includes('config.xml') ||
      new Set(paths).size !== paths.length ||
      sidecar.nativeFiles.some(
        (f) =>
          unsafePath(f.path) ||
          !nativeFile(f.path) ||
          (sidecar.version === 2 &&
            /(^|[\\/])\.([\\/]|$)|[\\/]{2}|[\u0000-\u001f\u007f]/.test(f.path)),
      )
    )
      throw new Error('Invalid native-file snapshot');
  } catch {
    ignore('invalid or unsupported browser sidecar');
    return;
  }
  // Exact text snapshots bind processed browser state to the files HFD can edit.
  // Folder prefixes may change when an exported folder is moved between computers.
  const key =
    sidecar.version === 2 ? (path: string) => normalized(path).normalize('NFC') : normalized;
  const native = files.filter((f) => key(f.path).startsWith(key(base)) && nativeFile(f.path));
  if (
    (sidecar.version === 1 && native.length !== sidecar.nativeFiles.length) ||
    sidecar.nativeFiles.some((snapshot) => {
      const matches = native.filter((f) => key(f.path) === key(base + snapshot.path));
      return matches.length !== 1 || matches[0].content !== snapshot.content;
    })
  ) {
    ignore('native files changed or are missing, so the browser snapshot is stale');
    return;
  }
  if (sidecar.version === 2) {
    // v2 binds the exact emitted manifest, allowing untouched unrelated folder
    // entries. Every resource the actual native import would consume must still
    // be listed. In particular, a formerly unloaded reference cannot appear as
    // an unlisted extra and silently be hidden by the browser snapshot.
    const actualPaths = files.map((file) => key(file.path)),
      listed = new Set(sidecar.nativeFiles.map((file) => key(base + file.path)));
    if (new Set(actualPaths).size !== actualPaths.length) {
      ignore('folder paths are ambiguous, so the browser snapshot is stale');
      return;
    }
    const bound = (matches: ProjectFile[]) =>
      matches.length <= 1 && (!matches.length || listed.has(key(matches[0].path)));
    const exact = (filename: string) =>
      files.filter((file) => normalized(file.path) === normalized(base + filename));
    const measurementBound = (filename: string) => {
      const direct = exact(filename);
      // Preserve native import's exact-path-first, then basename-only fallback.
      return bound(
        direct.length
          ? direct
          : files.filter(
              (file) =>
                normalized(file.path.split(/[\\/]/).at(-1) ?? '') ===
                normalized(filename.split(/[\\/]/).at(-1) ?? ''),
            ),
      );
    };
    const measurements = nativeProject.presets
        .flatMap((preset) => preset.channels)
        .map((channel) => channel.measurement?.name)
        .filter((name): name is string => !!name),
      calibration = nativeProject.hfdCalibration?.filename;
    if (
      measurements.some((filename) => !measurementBound(filename)) ||
      (calibration && !unsafePath(calibration) && !bound(exact(calibration)))
    ) {
      ignore(
        'a native referenced resource is unlisted or ambiguous, so the browser snapshot is stale',
      );
      return;
    }
  }
  const restored = sidecar.project as Project;
  if (restored.hfdCalibration) reconcileProjectHfdCalibration(restored);
  restored.warnings = [
    ...new Set([
      ...restored.warnings,
      'Restored browser-only processed measurement state from validated FusionProject.json. Native HFD uses Config.xml/DAT files only.',
    ]),
  ];
  return restored;
}

/** Report the input actually consumed, after the existing sidecar validation/fallback. */
export function importProjectFolderOpen(
  files: ProjectFile[],
  name = 'Imported HFD folder',
): DecodedProjectOpen {
  if (files.length > 2000 || files.reduce((n, f) => n + f.content.length, 0) > 80e6)
    throw new Error('Project folder exceeds import limits');
  const configs = files.filter(
    (f) => normalized(f.path).endsWith('/config.xml') || normalized(f.path) === 'config.xml',
  );
  if (configs.length !== 1)
    throw new Error('Choose one project folder containing a single Config.xml');
  const config = configs[0],
    base = config.path.replace(/[^\\/]+$/, ''),
    decoded = parseProjectOpen(config.content, name),
    project = decoded.project,
    doc = new DOMParser().parseFromString(config.content, 'application/xml');
  const restored = restoreSidecar(files, base, project);
  if (restored) return { project: restored, format: 'browser-snapshot' };
  const find = (filename: string) =>
    files.find((f) => normalized(f.path) === normalized(base + filename)) ??
    files.find(
      (f) =>
        normalized(f.path.split(/[\\/]/).at(-1) ?? '') ===
        normalized(filename.split(/[\\/]/).at(-1) ?? ''),
    );
  const calibration = project.hfdCalibration;
  if (calibration?.filename) {
    const matches = unsafePath(calibration.filename)
      ? []
      : files.filter((file) => normalized(file.path) === normalized(base + calibration.filename));
    if (matches.length > 1)
      throw new Error(`Ambiguous microphone correction file: ${calibration.filename}`);
    if (matches.length === 1) {
      const content = matches[0].content;
      calibration.resource = {
        content,
        curve: parseHfdCalibration(
          content,
          calibration.filename.replaceAll('\\', '/').split('/').at(-1)!,
        ),
      };
      project.warnings = project.warnings.filter(
        (warning) => warning !== UNRESOLVED_HFD_CALIBRATION_WARNING,
      );
    } else project.warnings.push(`Missing microphone correction file: ${calibration.filename}`);
  }
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      const node = doc.querySelector(
          `device > preset[index="${p + 1}"] > processobj[processtype="ptImpulse"][groupid="${c + 1}"]`,
        ),
        filename = node?.querySelector(':scope > filename')?.getAttribute('value');
      if (!filename) continue;
      const file = find(filename);
      if (!file) {
        project.warnings.push(`Missing measurement file: ${filename}`);
        continue;
      }
      const sampleRate = Number(
        node?.querySelector('options > meassamplingrate')?.getAttribute('value') ?? 48000,
      );
      const channel = project.presets[p].channels[c];
      channel.measurement = {
        ...channel.measurement,
        ...parseImpulse(file.content, filename, channel.hfdMeasurement?.sampleRate ?? sampleRate),
      };
      if (!project.hfdCalibration) recomputeHfdMeasurement(channel);
    }
  if (project.hfdCalibration) reconcileProjectHfdCalibration(project);
  return { project, format: decoded.format };
}
/** Passive compatibility API: importing never executes native FileOpen effects. */
export function importProjectFolder(files: ProjectFile[], name = 'Imported HFD folder'): Project {
  return importProjectFolderOpen(files, name).project;
}
export function projectFiles(project: Project): ProjectFile[] {
  const files: ProjectFile[] = [{ path: 'Config.xml', content: exportHfd(project) }];
  project.presets.forEach((p, i) =>
    p.channels.forEach((c, j) => {
      if (c.measurement?.impulse)
        files.push({ path: `P${i + 1}_CH${j + 1}.dat`, content: c.measurement.impulse.join('\n') });
      else if (c.measurement?.frequency)
        files.push({
          path: `P${i + 1}_CH${j + 1}.frd`,
          content: c.measurement.frequency
            .map((f, n) =>
              [f, c.measurement!.magnitude?.[n] ?? 0, c.measurement!.phase?.[n] ?? 0].join('\t'),
            )
            .join('\n'),
        });
    }),
  );
  if (project.hfdCalibration?.resource) {
    const filename = project.hfdCalibration.filename.replaceAll('\\', '/').split('/').at(-1) ?? '';
    if (!filename || unsafePath(filename) || !/\.(txt|dat)$/i.test(filename))
      throw new Error('Native calibration export requires a safe .txt or .dat filename');
    if (
      normalized(filename) === 'fusionproject.json' ||
      files.some((file) => normalized(file.path) === normalized(filename))
    )
      throw new Error(`Native calibration filename collides with a project file: ${filename}`);
    files.push({ path: filename, content: project.hfdCalibration.resource.content });
  }
  const sidecar = JSON.stringify(
    {
      format: 'fusion-studio-hfd-folder',
      // v2 binds only emitted files plus every actually resolved native input.
      // Unrelated preserved folder entries do not invalidate processed state.
      version: 2,
      nativeFiles: files,
      project,
    },
    null,
    2,
  );
  return [files[0], { path: 'FusionProject.json', content: sidecar }, ...files.slice(1)];
}
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP store format with UTF-8 names. No native compression dependency. */
export function zipFiles(files: ProjectFile[]): Uint8Array {
  if (files.length > 65535) throw new Error('Too many archive files');
  const encoder = new TextEncoder(),
    local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    if (/(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(f.path)) throw new Error('Unsafe archive path');
    const name = encoder.encode(f.path),
      data = encoder.encode(f.content),
      crc = crc32(data);
    if (name.length > 65535 || data.length > 80e6) throw new Error('Archive entry exceeds limits');
    const header = new Uint8Array(30 + name.length),
      v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x800, true);
    v.setUint16(12, 0x21, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, data);
    const record = new Uint8Array(46 + name.length),
      r = new DataView(record.buffer);
    r.setUint32(0, 0x02014b50, true);
    r.setUint16(4, 20, true);
    r.setUint16(6, 20, true);
    r.setUint16(8, 0x800, true);
    r.setUint16(14, 0x21, true);
    r.setUint32(16, crc, true);
    r.setUint32(20, data.length, true);
    r.setUint32(24, data.length, true);
    r.setUint16(28, name.length, true);
    r.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += header.length + data.length;
  }
  const length = central.reduce((n, b) => n + b.length, 0),
    end = new Uint8Array(22),
    v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, length, true);
  v.setUint32(16, offset, true);
  const all = [...local, ...central, end],
    total = offset + length + 22;
  if (total > 100e6) throw new Error('Archive exceeds 100 MB');
  const result = new Uint8Array(total);
  let at = 0;
  for (const b of all) {
    result.set(b, at);
    at += b.length;
  }
  return result;
}
export function downloadBytes(name: string, bytes: Uint8Array, type = 'application/zip') {
  downloadBrowserBlob(name, new Blob([new Uint8Array(bytes)], { type }));
}
