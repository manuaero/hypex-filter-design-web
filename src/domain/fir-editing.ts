import { emptyFir, type Fir, type Preset } from './model';
import { rootChannel } from './links';
import { firState, firLoaded, presetFirPlacement, validateFirState } from './fir-state';

export interface PresetFirPatch {
  name?: string;
  taps?: number[];
  enabled?: boolean;
  /** Explicit browser Unload: also resets bypass. Native coupled Clear differs. */
  clear?: boolean;
}
export type NativeFirAction =
  | { kind: 'clear'; output: 1 | 2 | 3 }
  | { kind: 'placement'; placement: 'input' | 'output' }
  | { kind: 'enabled'; channel: 0 | 1 | 2 | 3; enabled: boolean };
export interface ReadFirDesign {
  placement: 'input' | 'output';
  filters: Fir[];
  flags: number;
}

/** Reconcile a complete selected-placement hardware read without inventing
 * inactive samples. Hardware flags refresh all enable bits; inactive local
 * caches remain independently owned and bypassed through Used=false. */
export function applyReadFir(preset: Preset, result: ReadFirDesign): void {
  if (
    !result ||
    !['input', 'output'].includes(result.placement) ||
    !Number.isInteger(result.flags) ||
    result.flags < 0 ||
    result.flags > 255 ||
    !Array.isArray(result.filters) ||
    result.filters.length !== (result.placement === 'input' ? 1 : 3)
  )
    throw new Error('Invalid FIR read result');
  const proposed = nativeProposal(preset),
    previousPlacement = presetFirPlacement(preset),
    resources = [proposed.inputFir, ...proposed.channels.map((c) => c.fir)];
  for (let channel = 0; channel < 4; channel++) {
    const selected = result.placement === 'input' ? channel === 0 : channel > 0,
      bit = channel === 0 ? 3 : channel - 1,
      enabled = !!(result.flags & (1 << bit)),
      capacity = channel === 0 ? 4500 : 1500;
    if (selected) {
      const source = result.filters[result.placement === 'input' ? 0 : channel - 1],
        loaded = !!(result.flags & (1 << (bit + 4)));
      validateFirState(source, capacity);
      if (
        source.taps.length !== (loaded ? capacity : 0) ||
        (source.hfdState &&
          (source.hfdState.loaded !== loaded || source.hfdState.tapCount !== capacity))
      )
        throw new Error('FIR read data does not match the complete selected hardware bank');
      resources[channel] = {
        ...structuredClone(source),
        enabled,
        hfdState: { loaded, used: true, tapCount: capacity },
      };
    } else {
      const current = resources[channel];
      current.enabled = enabled;
      current.hfdState = {
        ...firState(current, (channel === 0) === (previousPlacement === 'input')),
        used: false,
      };
    }
    validateFirState(resources[channel], capacity);
  }
  preset.firPlacement = result.placement;
  preset.inputFir = resources[0];
  preset.channels.forEach((c, i) => {
    c.fir = resources[i + 1];
  });
}

/** Shared native design transaction. Hosts must disable ordinary link normalization. */
export function applyNativeFirAction(preset: Preset, action: NativeFirAction): void {
  if (!action || typeof action !== 'object' || Array.isArray(action))
    throw new Error('Invalid native FIR action');
  const keys =
    action.kind === 'clear'
      ? ['kind', 'output']
      : action.kind === 'placement'
        ? ['kind', 'placement']
        : action.kind === 'enabled'
          ? ['kind', 'channel', 'enabled']
          : [];
  if (!keys.length || Object.keys(action).some((key) => !keys.includes(key)))
    throw new Error('Invalid native FIR action');
  if (action.kind === 'clear') clearNativeFir(preset, action.output - 1);
  else if (action.kind === 'placement') selectNativeFirPlacement(preset, action.placement);
  else setNativeFirEnabled(preset, action.channel, action.enabled);
}

/** Input=0, output=1..3. Native file Load/Replace retains enabled and placement.
 * An explicitly supplied enabled:true is the existing browser combined action:
 * select this placement and bypass its opposite. Unload remains explicit.
 * All validation precedes mutation, and loaded arrays are independently owned. */
export function editPresetFir(preset: Preset, channel: number, patch: PresetFirPatch): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3)
    throw new Error('Invalid FIR channel');
  if (preset.channels.length !== 3 || new Set(preset.channels).size !== 3)
    throw new Error('FIR editing requires three independent output channels');
  const filters = [preset.inputFir, ...preset.channels.map((c) => c.fir)];
  if (new Set(filters).size !== 4) throw new Error('FIR resources must be independent');
  const roots = preset.channels.map((_, c) => rootChannel(preset, c));
  if (channel > 0 && roots[channel - 1] !== channel - 1)
    throw new Error('Linked output FIR is read-only; edit its source channel');
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => !['name', 'taps', 'enabled', 'clear'].includes(key)) ||
    (patch.name !== undefined && typeof patch.name !== 'string') ||
    (patch.taps !== undefined && !Array.isArray(patch.taps)) ||
    (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
    (patch.clear !== undefined && typeof patch.clear !== 'boolean')
  )
    throw new Error('Invalid FIR edit');

  const previous = filters[channel],
    next: Fir = patch.clear
      ? emptyFir()
      : {
          ...previous,
          name: patch.name ?? previous.name,
          enabled: patch.enabled ?? previous.enabled,
          taps: patch.taps === undefined ? previous.taps.slice() : patch.taps.slice(),
          ...(previous.hfdState ? { hfdState: { ...previous.hfdState } } : {}),
        },
    count = channel === 0 ? 4500 : 1500;
  if (!patch.clear && patch.taps !== undefined && next.hfdState)
    next.hfdState = { loaded: true, used: true, tapCount: next.taps.length };
  if (!patch.clear && patch.enabled === true && next.hfdState) next.hfdState.used = true;
  validateFirState(next, count);
  if (
    !Array.isArray(next.taps) ||
    (firLoaded(next) && next.taps.length !== count) ||
    next.taps.some((tap) => !Number.isFinite(tap)) ||
    (patch.taps !== undefined && next.taps.length > 0 && next.taps.every((tap) => tap === 0))
  )
    throw new Error(`Expected exactly ${count} finite FIR taps with a nonzero response`);
  if (patch.enabled === true && !firLoaded(next)) throw new Error('Load taps before enabling FIR');
  if (!next.hfdState && next.enabled && !next.taps.length)
    throw new Error('Load taps before enabling FIR');

  if (channel === 0) preset.inputFir = next;
  else
    for (let c = 0; c < 3; c++)
      if (roots[c] === channel - 1) preset.channels[c].fir = structuredClone(next);
  if (!patch.clear && patch.enabled === true) {
    preset.firPlacement = channel === 0 ? 'input' : 'output';
    if (channel === 0)
      preset.channels.forEach((c) => {
        c.fir.enabled = false;
        if (c.fir.hfdState) c.fir.hfdState.used = false;
      });
    else {
      preset.inputFir.enabled = false;
      if (preset.inputFir.hfdState) preset.inputFir.hfdState.used = false;
    }
  }
}

function nativeProposal(preset: Preset) {
  if (
    preset.channels.length !== 3 ||
    new Set(preset.channels).size !== 3 ||
    new Set([preset.inputFir, ...preset.channels.map((c) => c.fir)]).size !== 4
  )
    throw new Error('Native FIR operations require independent resources');
  preset.channels.forEach((_, i) => rootChannel(preset, i));
  const proposed = structuredClone(preset);
  validateFirState(proposed.inputFir, 4500);
  proposed.channels.forEach((c) => validateFirState(c.fir, 1500));
  return proposed;
}

/** Native loaded-FIR dialog Clear (c61874→c74254(1)): shared input plus selected
 * output, with latent Enabled and Ntaps retained. Ordinary link propagation
 * must be bypassed for this transaction, even when the selected output links. */
export function clearNativeFir(preset: Preset, selectedOutputIndex: number): void {
  if (!Number.isInteger(selectedOutputIndex) || selectedOutputIndex < 0 || selectedOutputIndex > 2)
    throw new Error('Invalid native FIR output channel');
  const proposed = nativeProposal(preset),
    placement = presetFirPlacement(preset),
    input = proposed.inputFir,
    output = proposed.channels[selectedOutputIndex].fir,
    inputState = firState(input, placement === 'input'),
    outputState = firState(output, placement === 'output');
  input.name = '';
  input.taps = [];
  input.hfdState = { ...inputState, loaded: false, used: false };
  output.name = '';
  output.taps = [];
  output.hfdState = { ...outputState, loaded: false };
  validateFirState(input, 4500);
  validateFirState(output, 1500);
  preset.inputFir = input;
  preset.channels[selectedOutputIndex].fir = output;
}

/** c73f34 changes application select and Used only, independently of Enabled. */
export function selectNativeFirPlacement(preset: Preset, placement: 'input' | 'output'): void {
  if (placement !== 'input' && placement !== 'output')
    throw new Error('Invalid native FIR placement');
  const proposed = nativeProposal(preset),
    prior = presetFirPlacement(preset);
  proposed.inputFir.hfdState = {
    ...firState(proposed.inputFir, prior === 'input'),
    used: placement === 'input',
  };
  proposed.channels.forEach((c) => {
    c.fir.hfdState = { ...firState(c.fir, prior === 'output'), used: placement === 'output' };
  });
  validateFirState(proposed.inputFir, 4500);
  proposed.channels.forEach((c) => validateFirState(c.fir, 1500));
  preset.firPlacement = placement;
  preset.inputFir = proposed.inputFir;
  proposed.channels.forEach((c, i) => {
    preset.channels[i].fir = c.fir;
  });
}

/** Native left-click bypass flag; it does not select a different placement or
 * rewrite the opposite FIR's latent enabled state. */
export function setNativeFirEnabled(preset: Preset, channel: number, enabled: boolean): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3 || typeof enabled !== 'boolean')
    throw new Error('Invalid native FIR enable action');
  const proposed = nativeProposal(preset),
    placement = presetFirPlacement(preset),
    target = channel === 0 ? proposed.inputFir : proposed.channels[channel - 1].fir;
  target.hfdState = firState(target, (channel === 0) === (placement === 'input'));
  if (enabled && !target.hfdState.loaded) throw new Error('Load taps before enabling FIR');
  target.enabled = enabled;
  validateFirState(target, channel === 0 ? 4500 : 1500);
  if (channel === 0) preset.inputFir = target;
  else preset.channels[channel - 1].fir = target;
}
