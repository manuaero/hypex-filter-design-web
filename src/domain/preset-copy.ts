import { projectSchema } from './files';
import { rootChannel } from './links';
import { processMeasurement } from './measurement';
import { recomputeHfdMeasurement, reconcileProjectHfdCalibration } from './hfd-measurement';
import type { Channel, Measurement, Preset, Project } from './model';

function index(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error('Invalid preset index');
}

function validate(project: Project): Project {
  const parsed = projectSchema.parse(project) as Project;
  if (new Set(project.presets).size !== 3)
    throw new Error('Aliased presets cannot be copied independently');
  const channels = project.presets.flatMap((preset) => preset.channels);
  if (new Set(channels).size !== 9 || new Set(channels.map((c) => c.filters)).size !== 9)
    throw new Error('Aliased channels cannot be copied independently');
  for (const preset of project.presets) {
    if (new Set(preset.channels.map((c) => c.id)).size !== 3)
      throw new Error('Preset channels require distinct identities');
    for (let c = 0; c < 3; c++) {
      rootChannel(preset, c);
      const filters = preset.channels[c].filters;
      if (new Set(filters).size !== 15 || new Set(filters.map((f) => f.id)).size !== 15)
        throw new Error('Biquad slots require distinct identities');
    }
  }
  return parsed;
}

function copyProcessing(source: Channel, destination: Channel) {
  destination.gain = source.gain;
  destination.invert = source.invert;
  destination.muted = source.muted;
  destination.delayUs = source.delayUs;
  destination.globalDelayUs = source.globalDelayUs;
  destination.fir = structuredClone(source.fir);
  destination.filters = source.filters.map((filter, i) => {
    const copy = structuredClone(filter),
      slot = destination.filters[i];
    copy.id = slot.id;
    if (slot.sourceId === undefined) delete copy.sourceId;
    else copy.sourceId = slot.sourceId;
    return copy;
  });
  destination.coefficientCache = source.coefficientCache === 'unresolved' ? 'unresolved' : 'base';
}

function clearMeasurement(destination: Channel) {
  delete destination.measurement;
  if (destination.hfdMeasurement)
    Object.assign(destination.hfdMeasurement, {
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
    });
}

function reloadMeasurement(source: Channel, destination: Channel) {
  const original = source.measurement;
  if (!original) {
    clearMeasurement(destination);
    return;
  }
  const rate =
      destination.hfdMeasurement?.sampleRate ??
      destination.measurement?.sampleRate ??
      original.sampleRate,
    replacement: Measurement = { name: original.name, sampleRate: rate };
  if (original.impulse) replacement.impulse = original.impulse.slice();
  else if (original.sourceSpectrum || original.frequency) {
    if (destination.hfdMeasurement)
      throw new Error(
        'Native preset copy requires original impulse samples for frequency-only measurements',
      );
    // Frequency-only files are a Browser-mode extension. Prefer archived
    // original arrays; legacy snapshots without them remain exact as supplied.
    const spectrum = original.sourceSpectrum ?? original;
    replacement.frequency = spectrum.frequency!.slice();
    replacement.magnitude = spectrum.magnitude!.slice();
    if (spectrum.phase) replacement.phase = spectrum.phase.slice();
  } else if (!original.name) {
    clearMeasurement(destination);
    return;
  }

  if (destination.hfdMeasurement) {
    destination.measurement = replacement;
    recomputeHfdMeasurement(destination, null);
    return;
  }
  if (!replacement.impulse && !replacement.frequency) {
    // Native LoadDAT may fail. Keep an unloaded reference and discard the old
    // active response; no data or processing metadata may masquerade as loaded.
    destination.measurement = replacement;
    return;
  }
  const processing = destination.measurement?.processing;
  destination.measurement = processMeasurement(replacement, {
    ...(processing?.window ? { window: structuredClone(processing.window) } : {}),
    smoothingOctaves: processing?.smoothingOctaves ?? 0,
    ...(processing?.calibration ? { calibration: structuredClone(processing.calibration) } : {}),
    calibrationEnabled: processing?.calibrationEnabled ?? false,
  });
}

function populate(source: Preset, destination: Preset) {
  destination.firPlacement = source.firPlacement ?? 'input';
  for (let c = 0; c < 3; c++) {
    copyProcessing(source.channels[c], destination.channels[c]);
    reloadMeasurement(source.channels[c], destination.channels[c]);
  }
}

/** Native PRE-02 scope (c502d0), extended to independent browser roles.
 * Source original DAT samples are reanalysed with destination options/resources.
 * Preserve destination EQ, input FIR, names, graph identities, links and
 * AdditionalGain. Do not run ordinary-edit link propagation after bulk copy.
 * Every parse, reload and rebuild finishes before the destination is assigned. */
export function copyPresetBetween(
  sourceProject: Project,
  sourceIndex: number,
  destinationProject: Project,
  destinationIndex: number,
): void {
  index(sourceIndex);
  index(destinationIndex);
  if (sourceProject === destinationProject && sourceIndex === destinationIndex)
    throw new Error('Copy requires two different presets');
  const source = validate(sourceProject),
    proposed =
      sourceProject === destinationProject ? structuredClone(source) : validate(destinationProject);
  populate(source.presets[sourceIndex], proposed.presets[destinationIndex]);
  reconcileProjectHfdCalibration(proposed, destinationProject);
  projectSchema.parse(proposed);
  destinationProject.presets[destinationIndex] = proposed.presets[destinationIndex];
}

export function copyPreset(project: Project, sourceIndex: number, destinationIndex: number): void {
  copyPresetBetween(project, sourceIndex, project, destinationIndex);
}
