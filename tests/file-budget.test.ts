import { expect, it, vi } from 'vitest';
import {
  assertFileByteBudget,
  readFileText,
  MAX_UI_TEXT_CHARACTERS,
  MAX_UI_FILE_BYTES,
  MAX_UI_TOTAL_BYTES,
  MAX_UI_FILE_COUNT,
} from '../src/application/file-budget';

it('shares the browser byte/count limits and accepts exact boundaries', () => {
  expect(MAX_UI_TEXT_CHARACTERS).toBe(80e6);
  expect(MAX_UI_FILE_BYTES).toBe(320e6);
  expect(MAX_UI_TOTAL_BYTES).toBe(640e6);
  expect(MAX_UI_FILE_COUNT).toBe(2000);
  expect(() => assertFileByteBudget([{ size: 320e6 }, { size: 320e6 }])).not.toThrow();
  expect(() =>
    assertFileByteBudget(Array.from({ length: 2000 }, () => ({ size: 0 }))),
  ).not.toThrow();
  expect(() => assertFileByteBudget([{ size: 320e6 + 1 }])).toThrow('byte budget');
  expect(() => assertFileByteBudget([{ size: 320e6 }, { size: 320e6 }, { size: 1 }])).toThrow(
    'total byte budget',
  );
  expect(() => assertFileByteBudget([])).toThrow('Choose');
  expect(() => assertFileByteBudget(Array.from({ length: 2001 }, () => ({ size: 0 })))).toThrow(
    'Choose',
  );
  for (const size of [-1, NaN, Infinity, 0.1])
    expect(() => assertFileByteBudget([{ size }])).toThrow('invalid size');
});

it('matches File.text for split UTF-8, BOM, non-BMP and malformed trailing bytes', async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('\ufeffAé漢😀B'), 0xe2, 0x82]);
  const original = new Blob([bytes]);
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
  const split = { size: bytes.length, stream } as Blob;
  expect(await readFileText(split)).toBe(await original.text());
});

it('counts UTF-16 units rather than bytes and keeps exact empty/text boundaries', async () => {
  expect(await readFileText(new Blob(['é漢😀']), 4)).toBe('é漢😀');
  await expect(readFileText(new Blob(['é漢😀']), 3)).rejects.toThrow('text character budget');
  expect(await readFileText(new Blob(), 0)).toBe('');
  expect(await readFileText(new Blob(['\ufeff']), 0)).toBe('');
  await expect(readFileText(new Blob(['a']), 0)).rejects.toThrow('text character budget');
});

it('cancels before consuming the rest of a stream when its text limit is crossed', async () => {
  const cancel = vi.fn();
  let pulls = 0;
  const blob = {
    size: 10,
    stream: () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('abcdef'));
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
  } as Blob;
  await expect(readFileText(blob, 3)).rejects.toThrow('text character budget');
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBe(1);
});

it('checks definitely oversized bytes before opening or decoding a stream', async () => {
  const stream = vi.fn();
  await expect(readFileText({ size: 320e6 + 1, stream } as unknown as Blob)).rejects.toThrow(
    'byte budget',
  );
  await expect(readFileText({ size: 34, stream } as unknown as Blob, 10)).rejects.toThrow(
    'text character budget',
  );
  expect(stream).not.toHaveBeenCalled();
  for (const limit of [-1, Infinity, 0.5, MAX_UI_TEXT_CHARACTERS + 1])
    await expect(readFileText(new Blob(), limit)).rejects.toThrow('Invalid text character budget');
});

it('detects streams with missing or extra bytes and cancels failed reads', async () => {
  const truncated = { size: 2, stream: () => new Blob(['a']).stream() } as Blob;
  await expect(readFileText(truncated)).rejects.toThrow('declared byte length');
  const oversized = { size: 1, stream: () => new Blob(['ab']).stream() } as Blob;
  await expect(readFileText(oversized)).rejects.toThrow('byte budget');
  const cancelled = vi.fn();
  const failed = {
    size: 1,
    stream: () =>
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('Disk read failed');
        },
        cancel: cancelled,
      }),
  } as Blob;
  await expect(readFileText(failed)).rejects.toThrow('Disk read failed');
});

it('preserves an original split BOM only when explicitly requested and counts it against the text limit', async () => {
  const bytes = new TextEncoder().encode('\ufeff:00000001FF\r\n');
  const split = () =>
    ({
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
    }) as Blob;
  expect(await readFileText(split(), 14, { preserveBom: true, fatal: true })).toBe(
    '\ufeff:00000001FF\r\n',
  );
  expect(await readFileText(split(), 13)).toBe(':00000001FF\r\n');
  await expect(readFileText(split(), 13, { preserveBom: true })).rejects.toThrow(
    'text character budget',
  );
  await expect(readFileText(new Blob(['\ufeff']), 0, { preserveBom: true })).rejects.toThrow(
    'text character budget',
  );
});

it('rejects invalid UTF-8 instead of replacing it in fatal mode, including a truncated final code point', async () => {
  for (const bytes of [
    new Uint8Array([0x61, 0xff]),
    new Uint8Array([0xe2, 0x82]),
    new Uint8Array([0xc0, 0xaf]),
  ]) {
    const blob = new Blob([bytes]);
    await expect(readFileText(blob, 10, { fatal: true })).rejects.toThrow();
    expect(await readFileText(blob)).toBe(await blob.text());
  }
  // Fatal decoding still accepts multi-byte characters split across stream reads.
  const bytes = new TextEncoder().encode('é漢😀');
  const split = {
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
  } as Blob;
  expect(await readFileText(split, 4, { fatal: true })).toBe('é漢😀');
});

it('cancels the unread stream immediately on a fatal decoding error', async () => {
  const cancel = vi.fn();
  let pulls = 0;
  const blob = {
    size: 10,
    stream: () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array([0xff]));
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
  } as Blob;
  await expect(readFileText(blob, 10, { fatal: true })).rejects.toThrow();
  expect(pulls).toBe(1);
  expect(cancel).toHaveBeenCalledOnce();
});
