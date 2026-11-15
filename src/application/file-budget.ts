/** Browser file limits, not native HFD format or device capacities. Individual
 * parsers retain their own project/resource/sample/tap limits. */
export const MAX_UI_TEXT_CHARACTERS = 80e6;
export const MAX_UI_FILE_BYTES = 320e6;
export const MAX_UI_TOTAL_BYTES = 640e6;
export const MAX_UI_FILE_COUNT = 2000;

/** Shared by human file pickers and offline agent file workflows. */
export function assertFileByteBudget(files: readonly { size: number }[]): void {
  if (!Array.isArray(files) || !files.length || files.length > MAX_UI_FILE_COUNT)
    throw new Error(`Choose 1–${MAX_UI_FILE_COUNT} files`);
  let total = 0;
  for (const file of files) {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_UI_FILE_BYTES)
      throw new Error('File exceeds the 320 MB byte budget or has an invalid size');
    total += file.size;
    if (total > MAX_UI_TOTAL_BYTES) throw new Error('Files exceed the 640 MB total byte budget');
  }
}

/**
 * File.text-compatible UTF-8 decoding with a live UTF-16 character budget.
 * A long legal browser impulse need not fit the old single-command text cap.
 * Native microphone callers explicitly pass their narrower 20m limit; the
 * project schema separately limits embedded native source XML to 20m.
 */
export async function readFileText(
  blob: Blob,
  maxCharacters = MAX_UI_TEXT_CHARACTERS,
  decoding: { preserveBom?: boolean; fatal?: boolean } = {},
): Promise<string> {
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 0 ||
    maxCharacters > MAX_UI_TEXT_CHARACTERS
  )
    throw new Error('Invalid text character budget');
  assertFileByteBudget([blob]);
  // At most three UTF-8 bytes encode one UTF-16 unit, plus an optional BOM.
  if (blob.size > maxCharacters * 3 + 3) throw new Error('File exceeds its text character budget');
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder('utf-8', {
    ignoreBOM: decoding.preserveBom ?? false,
    fatal: decoding.fatal ?? false,
  });
  const pieces: string[] = [];
  let characters = 0,
    bytes = 0;
  const append = (text: string) => {
    characters += text.length;
    if (characters > maxCharacters) throw new Error('File exceeds its text character budget');
    if (text) pieces.push(text);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > blob.size || bytes > MAX_UI_FILE_BYTES)
        throw new Error('File stream exceeds its byte budget');
      // Do not assume a stream implementation chooses small chunks.
      for (let offset = 0; offset < value.byteLength; offset += 65536)
        append(decoder.decode(value.subarray(offset, offset + 65536), { stream: true }));
    }
    if (bytes !== blob.size) throw new Error('File stream ended before its declared byte length');
    append(decoder.decode());
    return pieces.join('');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
