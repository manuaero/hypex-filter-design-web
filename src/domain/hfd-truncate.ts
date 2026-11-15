import { HFD_INDEX_MIN, HFD_INDEX_MAX, type Project } from './model';
import { effectiveHfdCropStart, setSharedHfdCrop, updateHfdMeasurement } from './hfd-measurement';

export interface NativeTruncateRange {
  timeMinMs: number;
  timeMaxMs: number;
}
export interface NativeTruncateResult {
  sampleRate: number;
  localStart: number;
  stopInclusive: number;
  effectiveStart: number;
  sharedAction: 'none' | 'retained-source' | 'cleared';
}
/** Native c671c0 multiplies ORIGINAL visible times by measurement Fs and
 * truncates toward zero. Setters9a3a20/38 store signedint32 without clipping;
 * crop readers bound actual original-array reads independently. */
export function truncateHfdVisibleRange(
  project: Project,
  presetIndex: number,
  channelIndex: number,
  range: NativeTruncateRange,
): NativeTruncateResult {
  if (
    !Number.isInteger(presetIndex) ||
    presetIndex < 0 ||
    presetIndex >= 3 ||
    !Number.isInteger(channelIndex) ||
    channelIndex < 0 ||
    channelIndex >= 3
  )
    throw new Error('Choose an explicit preset and output for native Truncate');
  if (
    !Number.isFinite(range.timeMinMs) ||
    !Number.isFinite(range.timeMaxMs) ||
    range.timeMinMs >= range.timeMaxMs
  )
    throw new Error('The visible time range must be finite and increasing');
  const preset = project.presets[presetIndex],
    original = preset.channels[channelIndex];
  if (!original.hfdMeasurement || !original.measurement?.impulse?.length)
    throw new Error(
      'Native Truncate requires HFD analysis and original impulse samples on every target',
    );
  const sampleRate = original.hfdMeasurement.sampleRate;
  const index = (ms: number) => {
    const value = Math.trunc((ms / 1000) * sampleRate) || 0;
    if (!Number.isSafeInteger(value) || value < HFD_INDEX_MIN || value > HFD_INDEX_MAX)
      throw new Error('Visible time bounds exceed native signed32-bit sample indices');
    return value;
  };
  const localStart = index(range.timeMinMs),
    stopInclusive = index(range.timeMaxMs),
    proposed = structuredClone(preset);
  const sourceChecked = original.hfdMeasurement.sharedGroupId === channelIndex + 1;
  const hadSharing = preset.channels.some(
    (channel) => channel.hfdMeasurement && channel.hfdMeasurement.sharedGroupId !== -1,
  );
  updateHfdMeasurement(proposed.channels[channelIndex], { localStart, stopInclusive });
  // c671c0 calls c637cc after refreshing. A checked source broadcasts the
  // effective OLD shared snapshot, while an unchecked follower unshares all.
  let sharedAction: NativeTruncateResult['sharedAction'] = 'none';
  if (sourceChecked) {
    setSharedHfdCrop(proposed, channelIndex);
    sharedAction = 'retained-source';
  } else if (hadSharing) {
    setSharedHfdCrop(proposed, null);
    sharedAction = 'cleared';
  }
  Object.assign(preset, proposed);
  return {
    sampleRate,
    localStart,
    stopInclusive,
    effectiveStart: effectiveHfdCropStart(proposed.channels[channelIndex].hfdMeasurement!),
    sharedAction,
  };
}
