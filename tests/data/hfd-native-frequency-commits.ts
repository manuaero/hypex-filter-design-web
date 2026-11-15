/** Sanitized HFD 5.2.4.24 classic offline GUI commit/save observations.
 * Decimal coefficient strings are native saved literals. Q24 and Single values
 * are independent software encodings, not physical target readback.
 * Raw text, model Single and rounded native XML text are distinct stages.
 * No full vendor project, machine path or device identity is distributed here.
 */

export const nativeFrequencyBounds = { min: 10, max: 50000 } as const;

export const nativeAsymmetricFrequencyBaseline = {
  kind: 'asymmetric',
  enabled: true,
  parameters: {
    filtertype: 'ftAsymShelf',
    f1: '800',
    f2: '400',
    q1: '0.7',
    q2: '1.3',
    gain: '0',
    shelfhl: 'stLowShelf',
  },
  coefficients: {
    b0: '1.02833350329289',
    b1: '-1.97799760650254',
    b2: '0.952509225064035',
    a1: '1.97887815703734',
    a2: '-0.979589437531044',
    sconst: '1',
    zconst: '1.02833350329289',
  },
  q24WireWords: [15980453, -33185293, 17252573, -16434784, 33200066],
  marker: {
    frequency: 800.0,
    db: 4.582832336425781,
  },
} as const;

export const nativeFrequencyCommitCases = [
  {
    name: 'minimum clamp',
    rawText: '1',
    expectedText: '10.0',
    expectedValue: 10.0,
    expectedFloat32LittleEndianHex: '00002041',
    kind: 'asymmetric',
    enabled: true,
    parameters: {
      filtertype: 'ftAsymShelf',
      f1: '800',
      f2: '10',
      q1: '0.7',
      q2: '1.3',
      gain: '0',
      shelfhl: 'stLowShelf',
    },
    coefficients: {
      b0: '1.03876739507293',
      b1: '-1.99806717819436',
      b2: '0.962173772744322',
      a1: '1.99948414039897',
      a2: '-0.99948458945985',
      sconst: '1',
      zconst: '1.03876739507293',
    },
    q24WireWords: [16142597, -33522005, 17427625, -16768569, 33545777],
    marker: {
      frequency: 800.0,
      db: 3.098994731903076,
    },
  },
  {
    name: 'raw decimal half tie',
    rawText: '10.35',
    expectedText: '10.4',
    expectedValue: 10.399999618530273,
    expectedFloat32LittleEndianHex: '66662641',
    kind: 'asymmetric',
    enabled: true,
    parameters: {
      filtertype: 'ftAsymShelf',
      f1: '800',
      f2: '10.3999996185303',
      q1: '0.7',
      q2: '1.3',
      gain: '0',
      shelfhl: 'stLowShelf',
    },
    coefficients: {
      b0: '1.03875668230857',
      b1: '-1.99804657221177',
      b2: '0.962163849886761',
      a1: '1.99946349288509',
      a2: '-0.99946397858429',
      sconst: '1',
      zconst: '1.03875668230857',
    },
    q24WireWords: [16142431, -33521659, 17427445, -16768223, 33545431],
    marker: {
      frequency: 800.0,
      db: 3.0990726947784424,
    },
  },
  {
    name: 'non-tie precision',
    rawText: '400.04',
    expectedText: '400.0',
    expectedValue: 400.0,
    expectedFloat32LittleEndianHex: '0000c843',
    kind: 'asymmetric',
    enabled: true,
    parameters: {
      filtertype: 'ftAsymShelf',
      f1: '800',
      f2: '400',
      q1: '0.7',
      q2: '1.3',
      gain: '0',
      shelfhl: 'stLowShelf',
    },
    coefficients: {
      b0: '1.02833350329289',
      b1: '-1.97799760650254',
      b2: '0.952509225064035',
      a1: '1.97887815703734',
      a2: '-0.979589437531044',
      sconst: '1',
      zconst: '1.02833350329289',
    },
    q24WireWords: [15980453, -33185293, 17252573, -16434784, 33200066],
    marker: {
      frequency: 800.0,
      db: 4.582832336425781,
    },
  },
  {
    name: 'maximum clamp',
    rawText: '50001',
    expectedText: '50000.0',
    expectedValue: 50000.0,
    expectedFloat32LittleEndianHex: '00504347',
    kind: 'asymmetric',
    enabled: true,
    parameters: {
      filtertype: 'ftAsymShelf',
      f1: '800',
      f2: '50000',
      q1: '0.7',
      q2: '1.3',
      gain: '0',
      shelfhl: 'stLowShelf',
    },
    coefficients: {
      b0: '0.150431282050419',
      b1: '-0.289354294969508',
      b2: '0.139339215762596',
      a1: '-0.550526712715731',
      a2: '-0.0759471899658616',
      sconst: '1',
      zconst: '0.150431282050419',
    },
    q24WireWords: [2337724, -4854560, 2523818, -1274182, -9236306],
    marker: {
      frequency: 800.0,
      db: -68.73865509033203,
    },
  },
] as const;

export const nativeDisabledTypeTransition = {
  before: {
    kind: 'lowpass2',
    enabled: false,
    parameters: {
      filtertype: 'ftLowPass2',
      f1: '720',
      f2: '988.101806640625',
      q1: '0.4',
      q2: '0.7',
      gain: '0',
      shelfhl: 'stUnknown',
    },
    coefficients: {
      b0: '0.00218985334083258',
      b1: '0',
      b2: '0',
      a1: '1.88416237410376',
      a2: '-0.886355508349538',
      sconst: '20465611.6860989',
      zconst: '0.00218985334083258',
    },
    q24WireWords: [0, 0, 36740, -14870578, 31610999],
    marker: {
      frequency: 720.0,
      db: -7.970118999481201,
    },
  },
  after: {
    kind: 'highpass2',
    enabled: false,
    parameters: {
      filtertype: 'ftHighPass2',
      f1: '720',
      f2: '988.101806640625',
      q1: '0.4',
      q2: '0.7',
      gain: '0',
      shelfhl: 'stUnknown',
    },
    coefficients: {
      b0: '0.941853163030452',
      b1: '-1.8837063260609',
      b2: '0.941853163030452',
      a1: '1.88416237410376',
      a2: '-0.886355508349538',
      sconst: '1',
      zconst: '0.941853163030452',
    },
    q24WireWords: [15801674, -31603348, 15801674, -14870578, 31610999],
    marker: {
      frequency: 720.0,
      db: -7.958797454833984,
    },
  },
} as const;

export const nativeRejectedUnitySelection = {
  kind: 'peak',
  enabled: false,
  parameters: {
    filtertype: 'ftBoostCut',
    f1: '720',
    f2: '988.101806640625',
    q1: '0.4',
    q2: '0.7',
    gain: '0',
    shelfhl: 'stUnknown',
  },
  coefficients: {
    b0: '1',
    b1: 'NaN',
    b2: 'NaN',
    a1: '1.88416237410376',
    a2: '-0.886355508349538',
    sconst: '1',
    zconst: '1',
  },
  expectedError: 'Invalid HFD b1',
} as const;

export const nativeZeroFrequencyCommit = {
  rawText: '0',
  previousValue: 720,
  expectedText: '720.0',
  expectedValue: 720,
} as const;
