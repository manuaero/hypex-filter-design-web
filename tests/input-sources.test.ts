import { expect, it } from 'vitest';
import { control, decodeStatus } from '../src/hardware/codec';
import {
  INPUT_SOURCES,
  CLONE_MASTER_INPUT_SOURCES,
  CLONE_SLAVE_INPUT_SOURCES,
  inputSourceLabel,
  isInputSource,
} from '../src/hardware/input-sources';

it('uses independent literal native source IDs, including S/PDIF4, AES5 and Future7', () => {
  expect(INPUT_SOURCES.map(({ id, label }) => [id, label])).toEqual([
    [0, 'Auto'],
    [1, 'XLR'],
    [2, 'RCA'],
    [3, 'Sub'],
    [4, 'S/PDIF'],
    [5, 'AES'],
    [6, 'Optical'],
    [7, 'Future'],
  ]);
  expect(Object.isFrozen(INPUT_SOURCES)).toBe(true);
  expect(INPUT_SOURCES.every(Object.isFrozen)).toBe(true);
  for (const [id, name] of [
    [4, 'S/PDIF'],
    [5, 'AES'],
    [7, 'Future'],
  ] as const) {
    const raw = new Uint8Array(64);
    raw.set([5, id, 2]);
    expect(inputSourceLabel(decodeStatus(raw).input)).toBe(name);
  }
});

it('preserves the proven distinct FA503 Clone menu ordering without offering Sub or Slave Auto', () => {
  expect(CLONE_MASTER_INPUT_SOURCES.map((source) => source.id)).toEqual([0, 1, 2, 5, 4, 6, 7]);
  expect(CLONE_SLAVE_INPUT_SOURCES.map((source) => source.id)).toEqual([1, 2, 5, 4, 6, 7]);
  expect(CLONE_MASTER_INPUT_SOURCES.find((source) => source.id === 4)?.label).toBe('S/PDIF');
  expect(CLONE_SLAVE_INPUT_SOURCES.find((source) => source.id === 5)?.label).toBe('AES');
});

it('packs all eight native source nibbles without altering flags or the other presets', () => {
  const raw = new Uint8Array(64);
  raw.set([5, 4, 2]);
  raw.set([0xa1, 0xf2, 0xb3], 12);
  const status = decodeStatus(raw),
    original = status.raw.slice();
  for (const id of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const request = control(status, { forceInput: id });
    expect(request[0]).toBe(5);
    expect(request[1]).toBe(0);
    expect(request[12]).toBe(0xa1);
    expect(request[13]).toBe(0xf0 | id);
    expect(request[14]).toBe(0xb3);
  }
  expect(status.raw).toEqual(original);
  for (const invalid of [-1, 8, 15, 1.5, NaN, Infinity])
    expect(() => control(status, { forceInput: invalid })).toThrow('Invalid source');
});

it('keeps unknown stored source values visible and preserves them on an unrelated control change', () => {
  const raw = new Uint8Array(64);
  raw.set([5, 15, 1]);
  raw[12] = 0xbf;
  const status = decodeStatus(raw);
  expect(inputSourceLabel(status.input)).toBe('Unknown input (15)');
  expect(isInputSource(15)).toBe(false);
  expect(isInputSource('7')).toBe(false);
  expect(control(status, { volume: -20 })[12]).toBe(0xbf);
  expect(status.raw).toEqual(raw);
});
