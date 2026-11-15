/** In-place radix-2 complex FFT, forward convention exp(-j*w*n). */
export function fft(real: Float64Array, imaginary: Float64Array, inverse = false) {
  const n = real.length;
  if (n !== imaginary.length || n < 1 || n & (n - 1))
    throw new Error('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length,
      wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let r = 1,
        im = 0;
      for (let j = 0; j < length / 2; j++) {
        const a = start + j,
          b = a + length / 2,
          tr = r * real[b] - im * imaginary[b],
          ti = r * imaginary[b] + im * real[b];
        real[b] = real[a] - tr;
        imaginary[b] = imaginary[a] - ti;
        real[a] += tr;
        imaginary[a] += ti;
        [r, im] = [r * wr - im * wi, r * wi + im * wr];
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imaginary[i] /= n;
    }
}
export function convolve(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  limit = a.length + b.length - 1,
) {
  if (!a.length || !b.length) return new Float64Array(0);
  const size = 2 ** Math.ceil(Math.log2(a.length + b.length - 1)),
    ar = new Float64Array(size),
    ai = new Float64Array(size),
    br = new Float64Array(size),
    bi = new Float64Array(size);
  ar.set(Array.from(a));
  br.set(Array.from(b));
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
  }
  fft(ar, ai, true);
  return ar.slice(0, Math.min(limit, a.length + b.length - 1));
}
