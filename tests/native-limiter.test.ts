import { describe, expect, it } from 'vitest';
import { packet } from '../src/hardware/codec';
import {
  loadNativeLimiter,
  editNativeLimiter,
  previewNativeLimiter,
  encodeNativeLimiter,
  type NativeLimiterAction,
  type NativeLimiterDraft,
} from '../src/hardware/native-limiter';

function source(third = true) {
  const raw = packet(0x66),
    view = new DataView(raw.buffer);
  for (let i = 2; i < 64; i++) raw[i] = (i * 11 + 7) & 255;
  raw[10] = 5;
  raw[12] = 22;
  raw[13] = third ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    view.setInt32(20 + i * 4, 17000000 + i, true);
    view.setInt32(32 + i * 4, 16273900 + i, true);
    view.setInt32(44 + i * 4, 16776377 + i, true);
    raw[56 + i] = 40;
    raw[59 + i] = 20;
  }
  return raw;
}
const load = (third = true, bridged = false) => loadNativeLimiter(source(third), { bridged });

describe('native limiter load and explicit callbacks', () => {
  it('separates loaded exact words, six-decimal editor Text and capped CH1 spinner presentation', () => {
    const raw = source(),
      draft = loadNativeLimiter(raw, { bridged: false });
    expect(draft.channels[0]).toMatchObject({
      thresholdText: '1.013279',
      attackText: '0.970000',
      releaseText: '0.999950',
      loaded: { thresholdWord: 17000000, attackWord: 16273900, releaseWord: 16776377 },
    });
    expect(draft.channels[1].loaded.releaseWord).toBe(16776378);
    expect(draft.channels[1].releaseText).toBe('0.999950');
    expect(draft.attackMs).toBe(0.833);
    expect(draft.releaseMs).toBe(99.9);
    // Untouched Update parses the formatted coefficient, never the capped release spinner.
    expect(previewNativeLimiter(draft).channels.map((c) => c.releaseWord)).toEqual([
      16776377, 16776377, 16776377,
    ]);
    const changed = editNativeLimiter(draft, { type: 'release-time', value: 99.9 });
    expect(previewNativeLimiter(changed).channels.map((c) => c.releaseWord)).toEqual([
      16776360, 16776360, 16776360,
    ]);
    expect(new DataView(raw.buffer).getInt32(48, true)).toBe(16776378);
  });

  it('uses native decimal half carry for exact binary loaded values and clamps programmatic loads', () => {
    const raw = source(),
      view = new DataView(raw.buffer);
    view.setInt32(32, 131072, true); // Exactly .0078125: decimal six-place half, away from zero.
    view.setInt32(36, 393216, true); // Exactly .0234375.
    view.setInt32(40, 33554432, true); // 2 clamps to the FloatEdit maximum 1 at load.
    view.setInt32(20, -131072, true);
    const draft = loadNativeLimiter(raw, { bridged: false });
    expect(draft.channels.map((c) => c.attackText)).toEqual(['0.007813', '0.023438', '1.000000']);
    expect(draft.channels[0].thresholdText).toBe('0.000000');
    expect(draft.channels[2].loaded.attack).toBe(2);
    // No expert exit occurred on the loaded hidden field: its 1.000000 stays 1 for normal Update.
    expect(previewNativeLimiter(draft).channels[2].attackWord).toBe(16777216);
  });

  it.each([
    ['attack-time', 0.3, '0.916667', 15379120],
    ['attack-time', 0.8, '0.968750', 16252928],
    ['attack-time', 1.1, '0.977273', 16395920],
    ['attack-time', 2.3, '0.989130', 16594848],
    ['release-time', 5, '0.900000', 15099494],
    ['release-time', 37.5, '0.999852', 16774733],
    ['release-time', 99.9, '0.999949', 16776360],
  ] as const)(
    'global %s %s reproduces independent decimal/Q24 fixture on all three outputs',
    (type, value, text, word) => {
      const draft = editNativeLimiter(load(), { type, value }),
        preview = previewNativeLimiter(draft),
        field = type === 'attack-time' ? 'attack' : 'release';
      expect(draft.channels.map((c) => c[`${field}Text`])).toEqual([text, text, text]);
      expect(preview.channels.map((c) => c[`${field}Word`])).toEqual([word, word, word]);
    },
  );

  it('preserves independent in-range expert Text and stale global spinner state across view-only mode changes', () => {
    const original = load();
    let draft = editNativeLimiter(original, {
      type: 'expert-text',
      channel: 1,
      field: 'attack',
      text: '0,123456789123',
    });
    draft = editNativeLimiter(draft, { type: 'expert-exit', channel: 1, field: 'attack' });
    expect(draft.channels[1].attackText).toBe('0,123456789123');
    expect(draft.channels[1].pendingExits).toBeUndefined();
    expect(draft.attackMs).toBe(original.attackMs);
    expect(draft.releaseMs).toBe(original.releaseMs);
    expect(draft.channels[0].attackText).toBe(original.channels[0].attackText);
    expect(previewNativeLimiter(draft).channels[1].attackWord).toBe(2071261);
    expect(original.channels[1].attackText).toBe('0.970000');
    // Normal/expert has no pure mutation action: simply showing either mode changes no values.
    expect(previewNativeLimiter(draft).draft.attackMs).toBe(original.attackMs);
  });

  it.each([
    ['1', '0.999990', 16777048],
    ['1.5', '0.999990', 16777048],
    ['-0.25', '0.100000', 1677722],
    ['0', '0', 0],
    ['', '', 0],
  ] as const)(
    'models explicit coefficient exit %s without inventing universal six-decimal normalization',
    (text, result, word) => {
      const edited = editNativeLimiter(load(), {
          type: 'expert-text',
          channel: 0,
          field: 'release',
          text,
        }),
        exited = editNativeLimiter(edited, { type: 'expert-exit', channel: 0, field: 'release' });
      expect(exited.channels[0].releaseText).toBe(result);
      expect(previewNativeLimiter(exited).channels[0].releaseWord).toBe(word);
      expect(previewNativeLimiter(edited).channels[0].releaseWord).toBe(word); // Review blur uses only pending fields.
    },
  );

  it('retains partial expert input until exit/review and fails atomically rather than encoding NaN', () => {
    const draft = editNativeLimiter(load(), {
      type: 'expert-text',
      channel: 2,
      field: 'attack',
      text: '.',
    });
    expect(draft.channels[2].attackText).toBe('.');
    const before = structuredClone(draft);
    expect(() =>
      editNativeLimiter(draft, { type: 'expert-exit', channel: 2, field: 'attack' }),
    ).toThrow(/valid limiter/);
    expect(() => previewNativeLimiter(draft)).toThrow(/valid limiter/);
    expect(draft).toEqual(before);
  });

  it('applies power integer conversion then five-watt callback, and permits native zero power', () => {
    let draft = load();
    draft = editNativeLimiter(draft, { type: 'power', channel: 0, value: 12.5 });
    expect(draft.channels[0].watts).toBe(10); // TSpinBox Integer getter: 12.5→12, callback: 12→10.
    draft = editNativeLimiter(draft, { type: 'power', channel: 0, value: 13 });
    expect(draft.channels[0].watts).toBe(15);
    draft = editNativeLimiter(draft, { type: 'power', channel: 0, value: 0 });
    const preview = previewNativeLimiter(draft);
    expect(preview.channels[0]).toMatchObject({ threshold: 0, thresholdWord: 0, watts: 0 });
    expect(preview.request[59]).toBe(0);
  });
});

describe('native limiter Update/encode', () => {
  it('recalculates every threshold at Update, replacing expert threshold Text, using independent native fixtures', () => {
    let draft = editNativeLimiter(load(), {
      type: 'expert-text',
      channel: 0,
      field: 'threshold',
      text: '12.3456789',
    });
    draft = editNativeLimiter(draft, { type: 'expert-exit', channel: 0, field: 'threshold' });
    expect(draft.channels[0].thresholdText).toBe('12.3456789');
    const preview = previewNativeLimiter(draft);
    expect(preview.draft.channels.map((c) => c.thresholdText)).toEqual([
      '2.871783',
      '2.871783',
      '5.401847',
    ]);
    expect(preview.channels.map((c) => c.thresholdWord)).toEqual([48180524, 48180524, 90627954]);
    expect(draft.channels[0].thresholdText).toBe('12.3456789');
  });

  it('reproduces another independent power/load fixture and the threshold clamp20', () => {
    let draft = load();
    for (const channel of [0, 1, 2] as const)
      draft = editNativeLimiter(draft, { type: 'power', channel, value: 105 });
    expect(previewNativeLimiter(draft).channels.map((c) => c.thresholdWord)).toEqual([
      49370330, 49370330, 92866018,
    ]);
    for (const channel of [0, 1, 2] as const) {
      draft = editNativeLimiter(draft, { type: 'power', channel, value: 1000 });
      draft = editNativeLimiter(draft, { type: 'impedance', channel, value: 25 });
    }
    expect(previewNativeLimiter(draft).channels.map((c) => c.thresholdWord)).toEqual([
      335544320, 335544320, 335544320,
    ]);
  });

  it('copies bridge impedance1→2 without linking power and emits hidden CH2 threshold20', () => {
    let draft = editNativeLimiter(load(), { type: 'power', channel: 1, value: 250 });
    draft = editNativeLimiter(draft, { type: 'impedance', channel: 1, value: 8 });
    draft = editNativeLimiter(draft, { type: 'bridge', value: true });
    expect(draft.channels[1].ohms).toBe(4);
    expect(draft.channels[1].watts).toBe(250);
    const preview = previewNativeLimiter(draft);
    // Independent decimal arithmetic: 1.435891 * 2^24 = 24090253.459456.
    // Halving the already-quantized unbridged word would give a different result.
    expect(preview.draft.channels[0].thresholdText).toBe('1.435891');
    expect(preview.channels.map((c) => c.thresholdWord)).toEqual([24090253, 335544320, 90627954]);
    expect(Array.from(preview.request.subarray(20, 24))).toEqual([0x8d, 0x96, 0x6f, 0x01]);
    const attemptedCh2 = editNativeLimiter(draft, { type: 'impedance', channel: 1, value: 12 });
    expect(attemptedCh2.channels[1].ohms).toBe(4);
    expect(draft.channels[0].ohms).toBe(4);
  });

  it('uses hidden output3 threshold20 without discarding power/load/coefficient state', () => {
    let draft = load(false);
    draft = editNativeLimiter(draft, { type: 'power', channel: 2, value: 105 });
    draft = editNativeLimiter(draft, { type: 'impedance', channel: 2, value: 8 });
    draft = editNativeLimiter(draft, {
      type: 'expert-text',
      channel: 2,
      field: 'attack',
      text: '.4567891234',
    });
    const preview = previewNativeLimiter(draft);
    expect(preview.channels[2]).toMatchObject({ watts: 105, ohms: 8, thresholdWord: 335544320 });
    expect(preview.request[58]).toBe(80);
    expect(preview.request[61]).toBe(21);
    expect(preview.draft.channels[2].attackText).toBe('.4567891234');
  });

  it('preserves every unowned66 byte, respects source byteOffset and returns independent serializable data', () => {
    const original = source(),
      containing = new Uint8Array(83);
    containing.set(original, 7);
    const draft = loadNativeLimiter(containing.subarray(7, 71), { bridged: false }),
      before = structuredClone(draft),
      first = previewNativeLimiter(draft),
      second = previewNativeLimiter(JSON.parse(JSON.stringify(draft)));
    expect(first).toEqual(second);
    expect(draft).toEqual(before);
    for (const i of [0, ...Array.from({ length: 18 }, (_, i) => i + 2), 62, 63])
      expect(first.request[i]).toBe(original[i]);
    expect(first.request[1]).toBe(1);
    first.request.fill(0);
    first.draft.channels[0].loaded.attackWord = 0;
    expect(encodeNativeLimiter(draft)).toEqual(second.request);
    expect(draft.channels[0].loaded.attackWord).toBe(16273900);
    expect(containing.subarray(7, 71)).toEqual(original);
  });

  it('serializes impedance metadata through native Single and positive-half-up rather than generic ties-even', () => {
    let draft = editNativeLimiter(load(), { type: 'impedance', channel: 0, value: 1.25 });
    let preview = previewNativeLimiter(draft);
    expect(preview.request[56]).toBe(13); // Single1.25 *10 =12.5, +.5 thenTrunc→13.
    expect(preview.channels[0]).toMatchObject({ ohms: 1.3, calculationOhms: 1.25 });
    draft = editNativeLimiter(draft, { type: 'impedance', channel: 0, value: 1.15 });
    preview = previewNativeLimiter(draft);
    expect(preview.request[56]).toBe(11); // Single1.15 is1.149999976..., below the half.
    expect(preview.channels[0]).toMatchObject({ ohms: 1.1, calculationOhms: 1.15 });
  });

  it('rejects incorrect protocol, malformed drafts and bad actions without mutating caller state', () => {
    const original = load(),
      saved = structuredClone(original);
    for (const action of [
      { type: 'power', channel: 0, value: -1 },
      { type: 'power', channel: 0, value: 1001 },
      { type: 'impedance', channel: 1, value: 0.9 },
      { type: 'impedance', channel: 1, value: 25.1 },
      { type: 'attack-time', value: 0.2 },
      { type: 'release-time', value: 100 },
      { type: 'power', channel: 3, value: 100 },
      { type: 'expert-text', channel: 0, field: 'attack', text: 'x'.repeat(129) },
    ] as unknown as NativeLimiterAction[])
      expect(() => editNativeLimiter(original, action)).toThrow();
    expect(original).toEqual(saved);
    const variants = [
      structuredClone(original),
      structuredClone(original),
      structuredClone(original),
    ];
    variants[0].channels[0].loaded.attackWord++;
    variants[1].thirdChannelEnabled = false;
    variants[2].sourceHex = '00';
    for (const draft of variants) expect(() => previewNativeLimiter(draft)).toThrow();
    expect(() => loadNativeLimiter(source().slice(0, 63), { bridged: false })).toThrow();
    const wrong = source();
    wrong[10] = 6;
    expect(() => loadNativeLimiter(wrong, { bridged: false })).toThrow();
  });
});
