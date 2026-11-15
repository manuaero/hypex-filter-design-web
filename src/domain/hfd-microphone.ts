import type { Project, HfdProjectCalibration } from './model';
import { parseHfdCalibration, DEFAULT_HFD_MIC_SMOOTHING } from './hfd-calibration';
import { reconcileProjectHfdCalibration } from './hfd-measurement';

function applyReference(project: Project, reference: HfdProjectCalibration): Project {
  const proposed = {
    ...project,
    hfdCalibration: structuredClone(reference),
    presets: structuredClone(project.presets),
  };
  reconcileProjectHfdCalibration(proposed);
  project.hfdCalibration = proposed.hfdCalibration;
  project.presets = proposed.presets;
  return project;
}

/** Native resource ownership is project-wide; loading never edits filter or
 * per-channel apply flags. Browser-only per-measurement curves remain separate. */
export function loadProjectMicrophone(project: Project, content: string, name: string): Project {
  if (content.length > 20e6) throw new Error('Native microphone file exceeds 20 MB');
  const filename = name.split(/[\\/]/).at(-1) ?? '';
  if (!filename || filename === '.' || filename === '..' || /[:\x00-\x1f]/.test(filename))
    throw new Error('Choose a microphone correction filename');
  if (!/\.(txt|dat)$/i.test(filename))
    throw new Error('Native microphone files must use .txt or .dat, matching HFD project export');
  const curve = parseHfdCalibration(content, filename);
  return applyReference(project, {
    filename,
    loaded: true,
    showCurve: project.hfdCalibration?.showCurve ?? false,
    smoothingOctaves: project.hfdCalibration?.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING,
    resource: { content, curve },
  });
}

export function unloadProjectMicrophone(project: Project): Project {
  return applyReference(project, {
    filename: '',
    loaded: false,
    showCurve: project.hfdCalibration?.showCurve ?? false,
    ...(project.hfdCalibration?.smoothingOctaves === undefined
      ? {}
      : { smoothingOctaves: project.hfdCalibration.smoothingOctaves }),
  });
}

export function setProjectMicrophoneOptions(
  project: Project,
  patch: { showCurve?: boolean; smoothingOctaves?: number },
): Project {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => !['showCurve', 'smoothingOctaves'].includes(key)) ||
    (patch.showCurve !== undefined && typeof patch.showCurve !== 'boolean') ||
    (patch.smoothingOctaves !== undefined &&
      (!Number.isFinite(patch.smoothingOctaves) ||
        patch.smoothingOctaves < 0 ||
        patch.smoothingOctaves > 3))
  )
    throw new Error('Invalid native microphone options');
  return applyReference(project, {
    ...(project.hfdCalibration ?? { filename: '', loaded: false, showCurve: false }),
    ...(patch.showCurve === undefined ? {} : { showCurve: patch.showCurve }),
    ...(patch.smoothingOctaves === undefined ? {} : { smoothingOctaves: patch.smoothingOctaves }),
  });
}

/** Optional startup seed only; an explicit imported project retains its own
 * selection. The remembered file is data, never permission for audio. */
export function inheritRememberedHfdCalibration(
  project: Project,
  remembered?: HfdProjectCalibration,
): Project {
  if (!project.hfdCalibration && remembered?.loaded && remembered.resource)
    return applyReference(project, { ...structuredClone(remembered), showCurve: false });
  return project;
}

/** Native New snapshots the current project's loaded microphone (c48bcf),
 * independently of the startup preference. Each stereo role has its own file. */
export function inheritProjectMicrophone(project: Project, current: Project): Project {
  return inheritRememberedHfdCalibration(project, current.hfdCalibration);
}

export function projectMicrophoneStatus(project: Project) {
  const reference = project.hfdCalibration;
  return {
    filename: reference?.filename ?? '',
    loaded: reference?.loaded ?? false,
    available: !!(reference?.loaded && reference.resource),
    showCurve: reference?.showCurve ?? false,
    smoothingOctaves: reference?.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING,
    points: reference?.resource?.curve.frequency.length ?? 0,
    warnings:
      reference?.loaded && !reference.resource
        ? ['The native project references a correction file that has not been loaded.']
        : [],
  };
}
