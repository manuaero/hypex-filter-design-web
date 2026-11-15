import { z } from 'zod';
import { captureConfigSchema, type CaptureConfig } from '../application/measurement-capture';

export const CAPTURE_PREFERENCES_KEY = 'fusion-studio.audio-preferences.v1';
export const MAX_CAPTURE_PREFERENCES_BYTES = 16 * 1024;

// Device selection is a preference, never a saved permission or live session.
// Native output gain starts at0; its persistence has not been established.
const routingSchema = captureConfigSchema.omit({ outputGainDb: true });
const envelopeSchema = z.object({ version: z.literal(1), config: routingSchema }).strict();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function checkSize(text: string) {
  // Bound allocation before encoding, and always bound data before JSON.parse.
  if (
    text.length > MAX_CAPTURE_PREFERENCES_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_CAPTURE_PREFERENCES_BYTES
  )
    throw new Error('Audio preferences exceed the 16 KiB storage limit');
}

/** Read only; malformed/unreadable data is reported, never silently overwritten. */
export function loadCapturePreferences(
  storage: Pick<Storage, 'getItem'>,
): CaptureConfig | undefined {
  let text: string | null;
  try {
    text = storage.getItem(CAPTURE_PREFERENCES_KEY);
  } catch (error) {
    throw new Error(`Audio preferences could not be read: ${errorText(error)}`, { cause: error });
  }
  if (text === null) return undefined;
  try {
    if (typeof text !== 'string') throw new Error('Expected a saved preference string');
    checkSize(text);
    const envelope = envelopeSchema.parse(JSON.parse(text));
    return captureConfigSchema.parse({ ...envelope.config, outputGainDb: 0 });
  } catch (error) {
    throw new Error(`Saved audio preferences are invalid and were retained: ${errorText(error)}`, {
      cause: error,
    });
  }
}

/** Validate the complete configuration before saving only routing preferences.
 * A failed validation/quota write is visible to the caller; no defaults follow. */
export function saveCapturePreferences(
  storage: Pick<Storage, 'setItem'>,
  config: CaptureConfig,
): void {
  const validated = captureConfigSchema.parse(config),
    routing = routingSchema.parse({
      inputDeviceId: validated.inputDeviceId,
      outputDeviceId: validated.outputDeviceId,
      inputChannel: validated.inputChannel,
      outputChannel: validated.outputChannel,
      ...(validated.requestedSampleRate === undefined
        ? {}
        : { requestedSampleRate: validated.requestedSampleRate }),
    }),
    text = JSON.stringify({ version: 1, config: routing });
  checkSize(text);
  try {
    storage.setItem(CAPTURE_PREFERENCES_KEY, text);
  } catch (error) {
    throw new Error(`Audio preferences could not be saved: ${errorText(error)}`, { cause: error });
  }
}
