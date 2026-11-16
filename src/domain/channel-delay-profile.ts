import type { Project } from './model';
import { formatHfdChannelDelayMaximum, type HfdChannelDelayProfile } from './channel-delay';

/** Supplied by the current application session, never by command arguments.
 * Offline means a fresh native designer's zero-initialized runtime version. */
export type ChannelDelayRuntime =
  | { readonly kind: 'offline' }
  | { readonly kind: 'connected'; readonly core: string; readonly sessionKey: string };

export interface ChannelDelayProfiles {
  readonly local: Readonly<HfdChannelDelayProfile>;
  readonly global: Readonly<HfdChannelDelayProfile>;
  /** Includes session identity even when two runtimes select equal bounds. */
  readonly contextKey: string;
}

/** Native runtime limits are independent of the XML device buildnr and each
 * saved local MaxDelay. Reading profiles never normalizes a document. */
export function resolveChannelDelayProfiles(
  project: Project,
  presetIndex: number,
  channelIndex: number,
  runtime: Readonly<ChannelDelayRuntime> = { kind: 'offline' },
): ChannelDelayProfiles {
  if (
    project?.model !== 'FA503' ||
    project.sampleRate !== 93750 ||
    project.presets.length !== 3 ||
    project.presets.some((preset) => preset.channels.length !== 3) ||
    ![presetIndex, channelIndex].every((i) => Number.isInteger(i) && i >= 0 && i < 3)
  )
    throw new Error('Delay editing requires a valid FA503 channel');
  let modern = false;
  let runtimeKey: string;
  if (runtime?.kind === 'offline') runtimeKey = 'offline:0.0';
  else if (runtime?.kind === 'connected') {
    const core = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(runtime.core);
    if (
      !core ||
      Number(core[1]) > 255 ||
      Number(core[2]) > 255 ||
      typeof runtime.sessionKey !== 'string' ||
      !runtime.sessionKey.length ||
      runtime.sessionKey.length > 1024
    )
      throw new Error('The current amplifier delay runtime is unavailable');
    const version = Number(core[1]),
      build = Number(core[2]);
    modern = version > 1 || (version === 1 && build >= 50);
    runtimeKey = `connected:${runtime.core}:${runtime.sessionKey}`;
  } else throw new Error('A trusted current delay runtime is required');

  const channel = project.presets[presetIndex].channels[channelIndex];
  let globalMaximum = channel.hfdDelay?.globalMaximum;
  if (globalMaximum === undefined) {
    // Browser-created designs use the native factory duration. A legacy native
    // snapshot may have a different bound (including zero); never guess it.
    if (project.sourceXml !== undefined)
      throw new Error(
        'Global delay limit is missing. Reopen the original HFD project to edit delays.',
      );
    globalMaximum = (7000 * 1e6) / project.sampleRate;
  }
  if (!Number.isFinite(globalMaximum) || globalMaximum < 0)
    throw new Error('The saved global delay limit is invalid');
  const profile = (kind: 'local' | 'global', maximum: number): Readonly<HfdChannelDelayProfile> =>
    Object.freeze({
      kind,
      unit: 'us',
      sampleRate: project.sampleRate,
      minimumText: '0',
      maximumText: formatHfdChannelDelayMaximum(maximum),
    });
  const local = profile('local', modern ? 32000 : 19200);
  const global = profile('global', globalMaximum);
  return Object.freeze({
    local,
    global,
    contextKey: JSON.stringify([
      runtimeKey,
      project.sampleRate,
      local.maximumText,
      global.maximumText,
    ]),
  });
}
