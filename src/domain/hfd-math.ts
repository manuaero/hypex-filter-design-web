import { FS, unity, type Coefficients, type Filter } from './model';
type Complex = [number, number];
const add = (a: Complex, b: Complex): Complex => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Complex, b: Complex): Complex => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Complex, b: Complex): Complex => [
  a[0] * b[0] - a[1] * b[1],
  a[0] * b[1] + a[1] * b[0],
];
const magnitude = (a: Complex) => Math.hypot(...a);
const product = (values: Complex[]) => values.reduce(mul, [1, 0] as Complex);
function roots(w: number, q: number): Complex[] {
  const a = -w / (2 * q),
    d = 4 * q * q - 1;
  if (d >= 0)
    return [
      [a, a * Math.sqrt(d)],
      [a, -a * Math.sqrt(d)],
    ];
  const r = Math.sqrt(-d);
  // Native real-pair construction uses complex 1 +/- i*sqrt(d).
  // Its constructor99d084 ->99d0b0 applies IsZero4551c0 with inclusive
  // abs(component)<=1e-12 before the later multiplication by a. Match only
  // this proved stage; do not snap general roots, coefficients or responses.
  const term = (value: number) => (Math.abs(value) <= 1e-12 ? 0 : value);
  return [
    [a * term(1 + r), 0],
    [a * term(1 - r), 0],
  ];
}
const real = (x: number): Complex => [x, 0];
/** Independent implementation of HFD's matched-z analog-root transform.
 * Reference normalization is 2000 Hz. See docs/HFD-FILTER-MATH.md and fixtures. */
export function designHfd(f: Filter): Coefficients {
  if (f.kind === 'unity' || !f.enabled) return unity();
  if (!(
    f.frequency > 0 &&
    f.frequency <= 50000 &&
    f.q > 0 &&
    f.q <= 100 &&
    Number.isFinite(f.gain)
  ))
    throw new Error('Frequency must be 0–50,000 Hz and Q must be 0–100');
  const w = 2 * Math.PI * f.frequency,
    G = 10 ** (f.gain / 20),
    s1 = 10 ** (f.gain / 40),
    s2 = 10 ** (f.gain / 80);
  let poles: Complex[] = [],
    zeros: Complex[] = [],
    constant = 1;
  switch (f.kind) {
    case 'lowpass1':
      poles = [real(-w)];
      constant = w;
      break;
    case 'lowpass2':
      poles = roots(w, f.q);
      constant = w * w;
      break;
    case 'highpass1':
      poles = [real(-w)];
      zeros = [real(0)];
      break;
    case 'highpass2':
      poles = roots(w, f.q);
      zeros = [real(0), real(0)];
      break;
    case 'lowshelf1':
      poles = [real(-w / s1)];
      zeros = [real(-w * s1)];
      break;
    case 'highshelf1':
      poles = [real(-w * s1)];
      zeros = [real(-w / s1)];
      constant = G;
      break;
    case 'lowshelf2':
      poles = roots(w / s2, f.q);
      zeros = roots(w * s2, f.q);
      break;
    case 'highshelf2':
      poles = roots(w * s2, f.q);
      zeros = roots(w / s2, f.q);
      constant = G;
      break;
    case 'asymmetric':
      if (!(f.frequency2 > 0 && f.frequency2 <= 50000 && f.q2 > 0 && f.q2 <= 100))
        throw new Error('Invalid asymmetric shelf poles');
      poles = roots(2 * Math.PI * f.frequency2, f.q2);
      zeros = roots(w, f.q);
      constant = f.shelfDirection === 'high' ? (f.frequency2 / f.frequency) ** 2 : 1;
      break;
    case 'peak':
      poles = roots(w, f.gain > 0 ? f.q : f.q * G);
      zeros = roots(w, f.gain > 0 ? f.q / G : f.q);
      break;
    case 'allpass1':
      poles = [real(-w)];
      zeros = [real(w)];
      break;
    case 'allpass2':
      poles = roots(w, f.q);
      zeros = poles.toReversed().map(([re, im]) => [-re, -im]);
      break;
    case 'raw':
      throw new Error('Raw coefficients must be supplied directly');
  }
  const mapped = (values: Complex[]) => {
    const a = values.map(([re, im]): Complex => {
      const r = Math.exp(re / FS);
      return [r * Math.cos(im / FS), r * Math.sin(im / FS)];
    });
    while (a.length < 2) a.push([0, 0]);
    return a;
  };
  const P = mapped(poles),
    Z = mapped(zeros),
    reference = 2 * Math.PI * 2000,
    s: Complex = [0, reference],
    z: Complex = [Math.cos(reference / FS), Math.sin(reference / FS)];
  const analog =
    (constant * magnitude(product(zeros.map((r) => sub(s, r))))) /
    magnitude(product(poles.map((r) => sub(s, r))));
  const digital =
    magnitude(product(Z.map((r) => sub(z, r)))) / magnitude(product(P.map((r) => sub(z, r))));
  const k = analog / digital,
    result = {
      b0: k,
      b1: -k * add(Z[0], Z[1])[0],
      b2: k * mul(Z[0], Z[1])[0],
      f1: add(P[0], P[1])[0],
      f2: -mul(P[0], P[1])[0],
    };
  if (!Object.values(result).every(Number.isFinite))
    throw new Error('Filter parameters overflow the matched-z transform');
  return result;
}
