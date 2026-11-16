import type { Channel, Fir, HfdFirState, Preset } from './model';

/** Legacy browser FIRs derive their state without migrating saved documents. */
export function firState(fir: Fir, fallbackUsed = true): HfdFirState {
  return fir.hfdState
    ? { ...fir.hfdState }
    : {
        loaded: fir.taps.length > 0,
        used: fallbackUsed,
        tapCount: fir.taps.length || 10,
      };
}
export const firLoaded = (fir: Fir) => fir.hfdState?.loaded ?? fir.taps.length > 0;
export const firUsed = (fir: Fir, fallbackUsed = true) => fir.hfdState?.used ?? fallbackUsed;
export const firIsEffective = (fir: Fir, fallbackUsed = true) =>
  fir.enabled && firLoaded(fir) && firUsed(fir, fallbackUsed) && fir.taps.length > 0;

export function validateFirState(fir: Fir, capacity: number): void {
  if (
    ![1500, 4500].includes(capacity) ||
    !fir ||
    typeof fir.name !== 'string' ||
    typeof fir.enabled !== 'boolean' ||
    !Array.isArray(fir.taps) ||
    fir.taps.length > capacity ||
    fir.taps.some((tap) => !Number.isFinite(tap))
  )
    throw new Error('Invalid FIR resource');
  const native = fir.hfdState;
  if (!native) return;
  if (
    typeof native !== 'object' ||
    Array.isArray(native) ||
    Object.keys(native).some((key) => !['loaded', 'used', 'tapCount'].includes(key)) ||
    typeof native.loaded !== 'boolean' ||
    typeof native.used !== 'boolean' ||
    !Number.isInteger(native.tapCount) ||
    native.tapCount < 0 ||
    native.tapCount > capacity ||
    fir.taps.length > native.tapCount
  )
    throw new Error('Invalid native FIR state');
  if (native.loaded && fir.taps.length !== native.tapCount)
    throw new Error(
      'A loaded native FIR requires its complete original tap cache; reload source data',
    );
}

export function presetFirPlacement(preset: Preset): 'input' | 'output' {
  if (preset.firPlacement !== undefined && !['input', 'output'].includes(preset.firPlacement))
    throw new Error('Invalid FIR placement');
  return (
    preset.firPlacement ??
    (preset.inputFir.enabled
      ? 'input'
      : preset.channels.some((c) => c.fir.taps.length)
        ? 'output'
        : 'input')
  );
}

/** Native graph processing gates Used, Enabled and Loaded independently.
 * Legacy projects retain placement-derived behavior. Two active native nodes
 * form an actual cascade; timed analysis uses their convolution. */
export function effectiveFirTaps(channel: Channel, preset?: Preset): number[] | undefined {
  const placement = preset ? presetFirPlacement(preset) : 'output',
    active =
      preset && firIsEffective(preset.inputFir, placement === 'input') ? [preset.inputFir] : [];
  if (firIsEffective(channel.fir, placement === 'output')) active.push(channel.fir);
  if (active.some((fir) => fir.taps.some((tap) => !Number.isFinite(tap))))
    throw new Error('Non-finite electrical FIR response');
  if (!active.length) return;
  if (active.length === 1) return active[0].taps;
  const [first, second] = active.map((fir) => fir.taps),
    result = new Float64Array(first.length + second.length - 1);
  for (let i = 0; i < first.length; i++) {
    if (first[i] === 0) continue;
    for (let j = 0; j < second.length; j++)
      if (second[j] !== 0) result[i + j] += first[i] * second[j];
  }
  return Array.from(result);
}

export interface SelectedFirPlacementPlan {
  placement: 0 | 1;
  banks: { filter: Fir; capacity: number; channel: number; loaded: boolean }[];
  warnings: string[];
}

/** Native c7cb28 -> a9fba8 selects physical transfer resources by application
 * placement, not graph Used. Loading can independently set Used (a94f94), so
 * the graph may contain a cascade that this one-placement transfer cannot
 * reproduce. Preserve that document and expose the difference as an advisory.
 * Capacity/encoding policy belongs to the transfer-specific caller. */
export function planSelectedFirPlacement(preset: Preset): SelectedFirPlacementPlan {
  if (preset.channels.length !== 3) throw new Error('FA503 requires three output FIRs');
  const placement = presetFirPlacement(preset) === 'input' ? 0 : 1,
    resources = [
      { filter: preset.inputFir, capacity: 4500, channel: 0 },
      ...preset.channels.map((c, i) => ({ filter: c.fir, capacity: 1500, channel: i + 1 })),
    ];
  for (const resource of resources) validateFirState(resource.filter, resource.capacity);
  const selected = (channel: number) => (placement === 0 ? channel === 0 : channel > 0),
    warnings = resources
      .filter((resource) => !selected(resource.channel) && firIsEffective(resource.filter, false))
      .map(
        (resource) =>
          `Inactive ${resource.channel === 0 ? 'input' : `output ${resource.channel}`} graph FIR is not transferred; only the selected placement is programmed.`,
      ),
    banks = resources
      .filter((resource) => selected(resource.channel))
      .map((resource) => ({ ...resource, loaded: firLoaded(resource.filter) }));
  return { placement: placement as 0 | 1, banks, warnings };
}

export interface FirActivationPlan extends SelectedFirPlacementPlan {
  flags: number;
  /** Native a9fba8's FIR-transfer-success gate, assuming successful programming. */
  anyLoaded: boolean;
}

/** Exact selected-placement ownership on a successful ordinary FA503 transfer.
 * Native a9fba8 gates enabled bits on a FIR transfer, separately from per-bank
 * Loaded flags. Inactive enabled bits remain hardware-owned; loaded bits clear.
 * This is a pure plan, never permission to bypass device preflight/recovery. */
export function planFirActivation(preset: Preset, previousFlags: number): FirActivationPlan {
  if (!Number.isInteger(previousFlags) || previousFlags < 0 || previousFlags > 255)
    throw new Error('Invalid previous FIR flags');
  const { placement, banks, warnings } = planSelectedFirPlacement(preset);
  for (const bank of banks) {
    if (!bank.filter.hfdState && bank.filter.enabled && !bank.filter.taps.length)
      throw new Error('An enabled FIR must have all taps loaded');
    if (bank.loaded && bank.filter.taps.length !== bank.capacity)
      throw new Error(
        `Reload source data: a selected loaded FIR requires ${bank.capacity} original taps`,
      );
  }
  const anyLoaded = banks.some((bank) => bank.loaded);
  let flags = previousFlags & (placement === 0 ? 7 : 8);
  for (const bank of banks) {
    const bit = placement === 0 ? 3 : bank.channel - 1;
    if (bank.loaded) flags |= 1 << (bit + 4);
    if (anyLoaded && bank.filter.enabled) flags |= 1 << bit;
  }
  return { placement, flags, anyLoaded, banks, warnings };
}
