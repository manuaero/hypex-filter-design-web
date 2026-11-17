import { newProject, type Project } from '../domain/model';
import { projectSchema } from '../domain/files';
import { applyReadFir } from '../domain/fir-editing';
import { decodeEq, decodeStatus, hex, settings, unhex, type PanelStatus } from '../hardware/codec';
import { readFir, type FirBackup } from '../hardware/fir';
import {
  captureNativeSaveTemplate,
  nativeSaveStatusMask,
  type NativeSaveSnapshot,
} from '../hardware/native-save-capture';
import type { Backup, Identity, PanelSession } from '../hardware/session';

export type AmplifierProjectIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export interface ReadAmplifierProjectResult {
  project: Project;
  identity: Identity;
  status: PanelStatus;
  backups: { crossover: Backup[]; fir: FirBackup[] };
}
export interface ReadAmplifierProjectOptions {
  /** Trusted synchronous role/session/revision fence; never an amplifier action. */
  assertCurrent?(): void;
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const changed = () =>
  new Error('Amplifier settings or identity changed during the read; no design was loaded');
function assertOrdinaryFir(snapshot: NativeSaveSnapshot): void {
  const config = snapshot.configuration,
    view = new DataView(config.buffer, config.byteOffset, config.byteLength);
  if (
    !(config[14] & 128) ||
    view.getUint16(50, true) !== 4500 ||
    [52, 54, 56].some((offset) => view.getUint16(offset, true) !== 1500) ||
    settings(decodeStatus(snapshot.status)).firMode !== 0
  )
    throw new Error(
      'Reading a complete design requires the verified ordinary 4500/1500-tap FIR mode',
    );
}
function assertStatus(before: Uint8Array, after: Uint8Array): void {
  const mask = nativeSaveStatusMask();
  // Also fence requested master volume and channel mute state. Telemetry can
  // change naturally and is not interpreted as a configuration transaction.
  mask[3] = mask[4] = 255;
  mask[6] |= 7;
  if (before.some((value, index) => ((value ^ after[index]) & mask[index]) !== 0)) throw changed();
}
function assertSameMetadata(before: NativeSaveSnapshot, after: NativeSaveSnapshot): void {
  assertStatus(before.status, after.status);
  if (
    !same(before.configuration, after.configuration) ||
    !same(before.deviceConfiguration.slice(2), after.deviceConfiguration.slice(2)) ||
    !same(before.serial, after.serial) ||
    !same(before.dspName, after.dspName) ||
    !same(before.mixerConfiguration, after.mixerConfiguration) ||
    !same(before.productStrings.hypexName, after.productStrings.hypexName) ||
    !same(before.productStrings.oemName, after.productStrings.oemName) ||
    before.eqPages.some((page, index) => !same(page.bytes, after.eqPages[index].bytes)) ||
    before.filenames.length !== after.filenames.length ||
    before.filenames.some(
      (name, index) =>
        name.address !== after.filenames[index].address ||
        !same(name.bytes, after.filenames[index].bytes),
    )
  )
    throw changed();
}

/** Read all three physical designs without selecting presets, muting or sending
 * setters. Backups are browser-owned recovery copies only. The caller publishes
 * the returned detached project after its final workspace fence and persists it.
 * Sequential reads do not establish an atomic snapshot against another controller. */
export async function readAmplifierProject(
  session: PanelSession,
  expected: AmplifierProjectIdentity,
  options: ReadAmplifierProjectOptions = {},
): Promise<ReadAmplifierProjectResult> {
  const target = {
      serial: expected?.serial,
      product: expected?.product,
      core: expected?.core,
      firmware: expected?.firmware,
    },
    assertCurrent = options.assertCurrent;
  const fence = () => {
    const result = (assertCurrent as (() => unknown) | undefined)?.();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw new Error('The amplifier read context fence must finish synchronously');
    }
  };
  const metadata = async () => {
    fence();
    const raw = await session.exclusive(() => session.captureNativeSaveSnapshotInternal(target));
    fence();
    assertOrdinaryFir(raw);
    return raw;
  };
  const before = await metadata(),
    crossover: Awaited<ReturnType<PanelSession['readPreset']>>[] = [],
    fir: Awaited<ReturnType<typeof readFir>>[] = [];
  const validateBackup = (backup: Backup | FirBackup) => {
    if (
      backup.serial !== target.serial ||
      backup.product !== target.product ||
      backup.firmware !== target.firmware
    )
      throw changed();
    assertStatus(before.status, decodeStatus(unhex(backup.status_hex)).raw);
  };
  for (const preset of [1, 2, 3]) {
    fence();
    const channels = await session.readPreset(preset);
    fence();
    validateBackup(channels.backup);
    crossover.push(channels);
    const bank = await readFir(session, preset);
    fence();
    validateBackup(bank.backup);
    fir.push(bank);
  }
  const after = await metadata();
  assertSameMetadata(before, after);
  const status = decodeStatus(after.status),
    template = captureNativeSaveTemplate(after, new Date().toISOString()),
    project = newProject(template.device.dspFilename || 'Read from amplifier');
  project.hfdSelectedPreset = status.preset;
  project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
  project.hfdCloneTemplate = template;
  project.warnings = [
    'Crossover sections contain physical compiled coefficients. Original filter shapes, frequency/Q and separately factored gain/polarity cannot be reconstructed from these banks.',
    'Only each preset’s selected FIR placement was decoded. Inactive flags and raw recovery bytes are retained; inactive tap caches were not invented.',
    'Measurements, microphone calibration and original driver labels are not stored in the amplifier and were not restored.',
  ];
  project.presets.forEach((preset, index) => {
    preset.channels = crossover[index].channels;
    preset.channels.forEach((channel, c) => {
      channel.name = `Output ${c + 1}`;
    });
    preset.inputEq = decodeEq(after.eqPages[index].bytes);
    preset.eqEnabled = !!(status.raw[12 + index] & 16);
    applyReadFir(preset, fir[index]);
    // The backup holds all four physical filenames even though its shared
    // coefficient memory has just one current placement interpretation.
    const names = fir[index].backup.filenames.map((name) =>
      new TextDecoder('latin1').decode(unhex(name.hex)).replace(/\0.*$/s, ''),
    );
    preset.inputFir.name = names[0];
    preset.channels.forEach((channel, c) => {
      channel.fir.name = names[c + 1];
    });
  });
  projectSchema.parse(project);
  fence();
  return {
    project,
    identity: {
      ...after.identity,
      name: template.device.dspFilename,
      configuration: hex(after.configuration),
    },
    status,
    backups: {
      crossover: crossover.map((result) => result.backup),
      fir: fir.map((result) => result.backup),
    },
  };
}
