import { it, expect } from 'vitest';
import { newProject } from '../src/domain/model';
import { linkChannel, synchronizeLinks, rootChannel } from '../src/domain/links';
it('copies linked processing but retains per-driver measurements, labels, IDs and additional gain', () => {
  const p = newProject(),
    pr = p.presets[0],
    a = pr.channels[0],
    b = pr.channels[1];
  a.gain = -3;
  a.filters[1].gain = 4;
  a.delayUs = 100;
  a.additionalGain = 10;
  b.additionalGain = 0;
  const id = b.filters[1].id;
  b.measurement = { name: 'Midrange', sampleRate: 48000, impulse: [0, 1] };
  linkChannel(pr, 1, 0);
  expect(b.gain).toBe(-3);
  expect(b.filters[1].gain).toBe(4);
  expect(b.filters[1].id).toBe(id);
  expect(b.name).toBe('Midrange');
  expect(b.measurement?.name).toBe('Midrange');
  expect(b.additionalGain).toBe(0);
  const before = structuredClone(p);
  a.gain = -8;
  b.gain = 7;
  synchronizeLinks(p, before);
  expect(b.gain).toBe(-8);
  expect(b.delayUs).toBe(100);
  linkChannel(pr, 1, null);
  a.gain = 2;
  synchronizeLinks(p);
  expect(b.gain).toBe(-8);
});
it('rejects cycles and retains original graph identities when linking a chain', () => {
  const p = newProject().presets[0];
  linkChannel(p, 1, 0);
  expect(() => linkChannel(p, 0, 1)).toThrow('Cyclic');
  linkChannel(p, 2, 1);
  expect(rootChannel(p, 2)).toBe(0);
  expect(() => linkChannel(p, 0, 0)).toThrow('different');
});
