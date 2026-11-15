import { encodeEq } from '../hardware/codec';
import { finite } from './dsp';
import type { Filter, Preset, Project } from './model';

export type EqBankEntry = { bands: Filter[]; enabled: boolean };
export type EqBank = EqBankEntry[];

// HFD 5.2.4.24's Default EQ handler reads this table through 0xd3fdbc.
// Its ninth entry is 16 kHz; this is not the new-project/erased-page path.
const DEFAULT_CENTERS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000] as const;
const EQ_KINDS = ['peak', 'lowshelf2', 'highshelf2'];

function presetIndex(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= 3)
    throw new Error('Invalid preset index: expected 0, 1 or 2');
}

function isLegacyBypass(band: Filter) {
  return band.kind === 'unity' && band.enabled === false;
}

function normalizedCopy(band: Filter): Filter {
  const copy = structuredClone(band);
  // Older browser Reset/Remove actions used disabled Unity for input EQ.
  // A disabled, zero-gain peak carries the same bypass without introducing
  // a non-native EQ type. Read/copy operations never migrate the source.
  if (isLegacyBypass(copy)) {
    copy.kind = 'peak';
    copy.gain = 0;
    delete copy.coefficients;
    delete copy.provenance;
  }
  return copy;
}

function validateBands(bands: Filter[]) {
  if (!Array.isArray(bands) || bands.length !== 9)
    throw new Error('Input EQ requires exactly nine bands');
  for (const band of bands) {
    if (
      !band ||
      typeof band !== 'object' ||
      (!EQ_KINDS.includes(band.kind) && !isLegacyBypass(band))
    )
      throw new Error('Input EQ supports peak, low shelf and high shelf');
    if (typeof band.id !== 'string' || typeof band.enabled !== 'boolean')
      throw new Error('Invalid input EQ band identity or enabled state');
    if (band.sourceId !== undefined && typeof band.sourceId !== 'string')
      throw new Error('Invalid input EQ source identity');
    const frequency = finite(band.frequency, 'Input EQ frequency');
    const q = finite(band.q, 'Input EQ Q');
    finite(band.gain, 'Input EQ gain');
    finite(band.frequency2, 'Input EQ second frequency');
    finite(band.q2, 'Input EQ second Q');
    // Check parameters even for disabled bands or panel coefficient caches,
    // which design() deliberately bypasses. encodeEq checks the wire ranges,
    // coefficient stability, Q8.24 quantization and nine-band page layout.
    if (!(frequency > 0 && frequency <= 50000 && q > 0 && q <= 100))
      throw new Error('Input EQ frequency must be 0–50,000 Hz and Q must be 0–100');
    if (band.coefficients)
      for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
        finite(band.coefficients[key], `Input EQ coefficient ${key}`);
  }
  encodeEq(bands.map(normalizedCopy));
}

function validateBank(bank: EqBank) {
  if (!Array.isArray(bank) || bank.length !== 3)
    throw new Error('An FA503 EQ bank requires exactly three presets');
  for (const entry of bank) {
    if (!entry || typeof entry.enabled !== 'boolean')
      throw new Error('Invalid input EQ active state');
    validateBands(entry.bands);
  }
}

function projectPresets(project: Project): Preset[] {
  if (!Array.isArray(project.presets) || project.presets.length !== 3)
    throw new Error('FA503 requires exactly three presets');
  if (new Set(project.presets).size !== 3)
    throw new Error('Aliased presets cannot be edited independently');
  for (const preset of project.presets) {
    if (!preset || typeof preset.eqEnabled !== 'boolean')
      throw new Error('Invalid input EQ active state');
    validateBands(preset.inputEq);
  }
  return project.presets;
}

function atDestination(bands: Filter[], destination: Filter[]): Filter[] {
  return bands.map((band, index) => {
    const copy = normalizedCopy(band);
    copy.id = destination[index].id;
    if (destination[index].sourceId === undefined) delete copy.sourceId;
    else copy.sourceId = destination[index].sourceId;
    return copy;
  });
}

/** Native Default EQ: current preset only, peak/gain 0/default centers,
 * every band enabled, existing Q and whole-EQ active state preserved.
 * Evidence: 0xcef924; see docs/HFD-EQ-SEMANTICS.md. Stages no USB write. */
export function resetInputEq(project: Project, index: number): void {
  presetIndex(index);
  const preset = projectPresets(project)[index];
  const bands = preset.inputEq.map((band, i) => {
    const copy = normalizedCopy(band);
    copy.kind = 'peak';
    copy.enabled = true;
    copy.frequency = DEFAULT_CENTERS[i];
    copy.gain = 0;
    // Native MakeSFilter regenerates the filter after the parameter reset.
    delete copy.coefficients;
    delete copy.provenance;
    delete copy.sourceType;
    delete copy.shelfDirection;
    return copy;
  });
  validateBands(bands);
  preset.inputEq = bands;
}

/** Stage the source preset's nine bands in selected presets. Per-preset
 * whole-EQ bypass remains independent, as in the native EQ-page copy path. */
export function copyInputEqToPresets(
  project: Project,
  sourcePreset: number,
  destinations: number[],
): void {
  presetIndex(sourcePreset);
  if (!Array.isArray(destinations)) throw new Error('Expected destination preset indices');
  destinations.forEach(presetIndex);
  const presets = projectPresets(project);
  const copies = [...new Set(destinations)]
    .filter((index) => index !== sourcePreset)
    .map((index) => ({
      index,
      bands: atDestination(presets[sourcePreset].inputEq, presets[index].inputEq),
    }));
  for (const copy of copies) presets[copy.index].inputEq = copy.bands;
}

/** A detached in-memory clipboard. The caller decides its browser lifetime;
 * it is not added to project data or persisted by these domain actions. */
export function snapshotEqBank(project: Project): EqBank {
  return projectPresets(project).map((preset) => ({
    bands: preset.inputEq.map(normalizedCopy),
    enabled: preset.eqEnabled,
  }));
}

/** Restore all three browser EQ-bank entries, including their active flags.
 * All validation and copies finish before any destination changes. */
export function applyEqBank(project: Project, bank: EqBank): void {
  const presets = projectPresets(project);
  validateBank(bank);
  const copies = bank.map((entry, index) => ({
    bands: atDestination(entry.bands, presets[index].inputEq),
    enabled: entry.enabled,
  }));
  copies.forEach((entry, index) => {
    presets[index].inputEq = entry.bands;
    presets[index].eqEnabled = entry.enabled;
  });
}
