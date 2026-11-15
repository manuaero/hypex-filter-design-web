import { normalizeManualNumberText } from './manual-number';

/** Ordinary output F1/F2 committed Text, not imported values or display formatting.
 * HFD5.2.4: c64990 clamps parsed Extended Text, formats '#0.0', then
 * c649e3/c64a1f reparses and c62eb7/c62f63 stores the model through Single.
 */
export interface HfdManualFrequencyOptions {
  /** Configuration.FMinFreq; the native field always raises this to at least10. */
  min?: number;
  /** Native field maximum. Ordinary browser manual edits use50000. */
  max?: number;
  /** Only needed for exact0: native ZeroValueAllowed=false keeps its old Value. */
  previousValue?: number;
}
export interface HfdManualFrequencyResult {
  text: string;
  value: number;
}

/** Bounded whole-value edit; does not reproduce native per-keystroke timing.
 * Accepts ASCII decimal dot/comma and ordinary exponents (<=128 chars,
 * absolute explicit/net exponent<=400). Rejects special/nonfinite strings.
 * Numeric manual-command callers may deliberately use String(number) as their
 * canonical decimal input; that is distinct from formatting an existing Double.
 * This pure function never modifies a document or normalizes an imported value.
 */
export function normalizeHfdManualFrequencyText(
  text: string,
  { min = 10, max = 50000, previousValue }: HfdManualFrequencyOptions = {},
): HfdManualFrequencyResult {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    Math.abs(min) > 50000 ||
    max <= 0 ||
    max > 50000
  )
    throw new Error('Invalid manual frequency bounds');
  return normalizeManualNumberText(text, {
    min: Math.max(10, min),
    max,
    previousValue,
    places: 1,
    zeroAllowed: false,
    storage: 'single',
    label: 'Frequency',
  });
}
