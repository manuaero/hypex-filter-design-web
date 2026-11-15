/** Sanitized HFD 5.2.4.24 saved-cache observations from five completed saves.
 * These are semantic records/literals, not complete native projects. Tests
 * reconstruct a synthetic HFD_TEMPLATE container; its bytes are not native saves.
 * All five saves retain the same BASE BQ cache despite channel gain/inversion.
 * No baked-cache transition, native upload or physical programming is claimed.
 */
export const nativeChannelCacheSection = {
  sourceId: '13',
  enabled: true,
  parameters: {
    filtertype: 'ftBoostCut',
    f1: '2300',
    f2: '988.101806640625',
    q1: '1.15',
    q2: '0.7',
    gain: '7.5',
    shelfhl: 'stUnknown',
  },
  roots: {
    spoles: '2',
    szeros: '2',
    zpoles: '2',
    zzeros: '2',
    sconst: '1',
    zconst: '1.09247603795187',
  },
  coefficients: {
    b0: '1.09247603795187',
    b1: '-1.86528064992647',
    b2: '0.794998327675381',
    a1: '1.85236017184606',
    a2: '-0.874553956539528',
  },
} as const;

// Literal Decimal arithmetic at precision 80: multiply the saved numerator by
// sign*10^((channel gain+AdditionalGain)/20), then Q24 nearest-even. Order is
// b2,b1,b0,a2,a1. These are independent software predictions, not native packets.
const baseWords = [13337859, -31294216, 18328706, -14672581, 31077447] as const;
const minusSixWords = [6684764, -15684262, 9186114, -14672581, 31077447] as const;
const invertedWords = [-6684764, 15684262, -9186114, -14672581, 31077447] as const;

export const nativeChannelCacheStates = [
  {
    name: 'opened',
    savedBytes: 149019,
    savedSha256: 'c71d6f971c44279839f01a53618a51f0a8a9fd54c0ba0e5802d43182eadb1a54',
    channelGain: '0',
    invert: false,
    effectiveQ24Words: baseWords,
  },
  {
    name: 'graph without a selected filter',
    savedBytes: 149019,
    savedSha256: 'c71d6f971c44279839f01a53618a51f0a8a9fd54c0ba0e5802d43182eadb1a54',
    channelGain: '0',
    invert: false,
    effectiveQ24Words: baseWords,
  },
  {
    name: 'channel gain −6 dB',
    savedBytes: 149020,
    savedSha256: '242c958dd87cdea3188c0f6b388dc92ad53a1e6528ae58705c0968ad4048e666',
    channelGain: '-6',
    invert: false,
    effectiveQ24Words: minusSixWords,
  },
  {
    name: 'inverted channel',
    savedBytes: 149019,
    savedSha256: '1de4086fd924d3073b9fee7e9c9838c99e89dd29f47a8a9d1749a711a3285dd5',
    channelGain: '-6',
    invert: true,
    effectiveQ24Words: invertedWords,
  },
  {
    name: 'selected Peak followed by Save As',
    savedBytes: 149019,
    savedSha256: '1de4086fd924d3073b9fee7e9c9838c99e89dd29f47a8a9d1749a711a3285dd5',
    channelGain: '-6',
    invert: true,
    effectiveQ24Words: invertedWords,
  },
] as const;

// Independent complex evaluation of the saved literals at 2300 Hz/Fs 93750.
// Screenshots establish selected/unselected context qualitatively; these
// numbers are literal-derived predictions, not quantified native raster output.
export const nativeChannelCacheSectionResponse = {
  frequency: 2300,
  real: 2.3713694889581016,
  imaginary: 0.005593280343526398,
  db: 7.500008716167609,
  markerSingleDb: 7.500008583068848,
} as const;
