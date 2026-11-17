import { expect, it } from 'vitest';
import { decodeFirName, firDisplayName } from '../src/domain/fir-name';

it('treats erased and zeroed EEPROM slots as empty without modifying recovery bytes', () => {
  const bytes = new Uint8Array(32).fill(255);
  expect(decodeFirName(bytes)).toBe('');
  expect(bytes.every((byte) => byte === 255)).toBe(true);
  expect(decodeFirName(new Uint8Array(32))).toBe('');
  expect(firDisplayName('ÿ'.repeat(32))).toBe('');
});

it('preserves real Latin-1 filenames, null termination and full length names', () => {
  const bytes = new Uint8Array(32).fill(255);
  bytes.set([99, 97, 102, 233, 46, 116, 120, 116, 0]);
  expect(decodeFirName(bytes)).toBe('café.txt');
  expect(decodeFirName(new Uint8Array(32).fill(97))).toBe('a'.repeat(32));
  expect(firDisplayName('ÿ.txt')).toBe('ÿ.txt');
});
