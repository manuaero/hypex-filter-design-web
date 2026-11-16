import type {
  Channel,
  CoefficientCache,
  Coefficients,
  Filter,
  NativeCacheContext,
  NativeDirectCacheWitness,
} from './model';
import { designHfd } from './hfd-math';

export const coefficientKeys = ['b0', 'b1', 'b2', 'f1', 'f2'] as const;
export function finiteCoefficients(value: Coefficients): Coefficients {
  if (!value || !coefficientKeys.every((key) => Number.isFinite(value[key])))
    throw new Error('Native cache requires five finite coefficients');
  return { b0: value.b0, b1: value.b1, b2: value.b2, f1: value.f1, f2: value.f2 };
}
export function sameCoefficients(a: Coefficients, b: Coefficients): boolean {
  return coefficientKeys.every((key) => Object.is(a[key], b[key]));
}
export function nativeCacheScalar(
  context: Pick<NativeCacheContext, 'gain' | 'additionalGain' | 'invert'>,
): number {
  return 10 ** ((context.gain + (context.additionalGain ?? 0)) / 20) * (context.invert ? -1 : 1);
}
export function canonicalNativeCache(raw: Coefficients, context: NativeCacheContext): Coefficients {
  const original = finiteCoefficients(raw);
  if (context.coefficientCache !== 'effective') return original;
  const scalar = nativeCacheScalar(context);
  if (!Number.isFinite(scalar) || scalar === 0)
    throw new Error('Invalid native cache normalization context');
  return finiteCoefficients({
    ...original,
    b0: original.b0 / scalar,
    b1: original.b1 / scalar,
    b2: original.b2 / scalar,
  });
}

/** Shared passive importer/CopyTo classifier. Tolerance and unit/unknown rules
 * preserve the established import policy; they grant no upload permission. */
export function classifyNativeCache(
  raw: Coefficients,
  filter: Filter,
  context: Pick<NativeCacheContext, 'gain' | 'additionalGain' | 'invert'>,
  forced?: 'base' | 'unresolved',
): { coefficients: Coefficients; coefficientCache: CoefficientCache } {
  const original = finiteCoefficients(raw),
    scalar = nativeCacheScalar(context);
  if (forced === 'unresolved') return { coefficients: original, coefficientCache: 'unresolved' };
  if (forced === 'base' || scalar === 1)
    return { coefficients: original, coefficientCache: 'base' };
  let canonical = original;
  let classification: CoefficientCache = 'effective';
  let base: Coefficients | undefined;
  try {
    base = designHfd({ ...filter, enabled: true });
  } catch {
    /* Custom cache has no parameter oracle. */
  }
  if (base) {
    const scaled = { ...base, b0: base.b0 * scalar, b1: base.b1 * scalar, b2: base.b2 * scalar };
    const matches = (expected: Coefficients) =>
      coefficientKeys.every(
        (key) => Math.abs(original[key] - expected[key]) / (1 + Math.abs(expected[key])) < 1e-9,
      );
    if (matches(base) && !matches(scaled)) {
      canonical = original;
      classification = 'base';
    } else if (!matches(base) && !matches(scaled)) {
      canonical = original;
      classification = 'unresolved';
    }
  } else if (Math.abs(scalar - 1) > 1e-12) {
    canonical = original;
    classification = 'unresolved';
  }
  if (classification === 'effective')
    canonical = canonicalNativeCache(original, { ...context, coefficientCache: 'effective' });
  return { coefficients: canonical, coefficientCache: classification };
}

function data(filter: Filter) {
  // Enabled is a bypass flag, not a write to the native direct cache.
  const { enabled: _enabled, ...rest } = filter;
  return rest;
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
export function captureNativeCacheWitness(
  channel: Channel,
  raw: Coefficients,
  context: NativeCacheContext = {
    gain: channel.gain,
    additionalGain: channel.additionalGain,
    invert: channel.invert,
    coefficientCache: channel.coefficientCache ?? 'base',
  },
): NativeDirectCacheWitness {
  if (channel.filters.length !== 15 || !channel.filters[0].coefficients)
    throw new Error(
      'Native cache witness requires fifteen bound slots and a canonical first cache',
    );
  const native = finiteCoefficients(raw);
  if (!sameCoefficients(canonicalNativeCache(native, context), channel.filters[0].coefficients))
    throw new Error('Native cache witness normalization does not match its canonical filter');
  return {
    version: 1,
    native,
    firstFilter: structuredClone(channel.filters[0]),
    filterIds: channel.filters.map((filter) => filter.id),
    context: { ...context },
  };
}
/** Gain, inversion and Enabled may change without modifying cached BQ Doubles.
 * The original normalization context remains provenance, not a live gain fence. */
export function validNativeCacheWitness(channel: Channel): NativeDirectCacheWitness | undefined {
  const witness = channel.hfdDirectCacheWitness;
  if (
    !witness ||
    witness.version !== 1 ||
    channel.filters.length !== 15 ||
    witness.filterIds.length !== 15 ||
    witness.filterIds.some((id, i) => id !== channel.filters[i].id) ||
    witness.context.coefficientCache !== (channel.coefficientCache ?? 'base') ||
    !same(data(witness.firstFilter), data(channel.filters[0]))
  )
    return;
  try {
    if (
      !channel.filters[0].coefficients ||
      !sameCoefficients(
        canonicalNativeCache(witness.native, witness.context),
        channel.filters[0].coefficients,
      )
    )
      return;
    return witness;
  } catch {
    return;
  }
}
