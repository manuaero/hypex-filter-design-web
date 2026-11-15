// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { newProject } from '../src/domain/model';
import { projectFiles, importProjectFolder, zipFiles, crc32 } from '../src/domain/project-io';
it('exports HFD-style DAT files beside Config.xml and imports their correct sample rate', () => {
  const p = newProject('Measured design');
  p.presets[1].channels[2].measurement = {
    name: 'Tweeter impulse',
    sampleRate: 96000,
    impulse: [0, 0, 1, 0],
  };
  const files = projectFiles(p);
  expect(files.map((f) => f.path)).toEqual(['Config.xml', 'FusionProject.json', 'P2_CH3.dat']);
  const imported = importProjectFolder(files, 'Imported');
  expect(imported.presets[1].channels[2].measurement?.impulse).toEqual([0, 0, 1, 0]);
  expect(imported.presets[1].channels[2].measurement?.sampleRate).toBe(96000);
  expect(imported.presets[0].channels[0].measurement).toBeUndefined();
});
it('requires one project config and reports missing associated measurements', () => {
  const p = newProject();
  p.presets[0].channels[0].measurement = { name: 'Impulse', sampleRate: 48000, impulse: [1, 0] };
  const files = projectFiles(p).filter((f) => f.path === 'Config.xml');
  expect(importProjectFolder(files).warnings.join(' ')).toContain('P1_CH1.dat');
  expect(() => importProjectFolder([...files, ...files])).toThrow('single Config.xml');
});
it('uses standard ZIP CRC32 and rejects path traversal', () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  expect(() => zipFiles([{ path: '../outside.txt', content: 'x' }])).toThrow('Unsafe');
  const zip = zipFiles([{ path: 'Config.xml', content: '<project/>' }]);
  expect(zip.slice(0, 4)).toEqual(Uint8Array.from([80, 75, 3, 4]));
});
