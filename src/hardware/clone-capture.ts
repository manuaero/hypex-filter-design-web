import type { NativeCloneTemplate } from '../domain/clone-template';
import { assertCloneTargetSnapshot, type CloneTargetSnapshot } from './clone-plan';
import { captureNativeSaveTemplate, nativeSaveFilenameAddresses } from './native-save-capture';

export interface CloneCaptureSnapshot extends CloneTargetSnapshot {
  mixerConfiguration: Uint8Array;
  productStrings: { hypexName: Uint8Array; oemName: Uint8Array };
}

/** Clone retains its full backup contract; only its pure info projection shares
 * the narrow native-Save mapper. No unused flash pages are fabricated. */
export function captureNativeCloneTemplate(
  snapshot: CloneCaptureSnapshot,
  capturedAt?: string,
): NativeCloneTemplate {
  assertCloneTargetSnapshot(snapshot, { allowLocked: true });
  const selected = nativeSaveFilenameAddresses(snapshot.status);
  return captureNativeSaveTemplate(
    {
      ...snapshot,
      filenames: snapshot.filenames.filter((value) => selected.includes(value.address)),
      eqPages: ([1, 2, 3] as const).map((preset) => ({
        preset,
        address: 0x24000 + preset * 4096,
        bytes: snapshot.flash
          .find((value) => value.address === 0x24000 + preset * 4096)!
          .bytes.slice(0, 256),
      })),
    },
    capturedAt,
  );
}
