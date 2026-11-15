import { type Preset, type Fir, uid } from '../domain/model';
import { planFirActivation, presetFirPlacement } from '../domain/fir-state';
import { q24 } from '../domain/dsp';
import { addr, hex, unhex, packet, decodeStatus, settings } from './codec';
import type { PanelSession, Progress } from './session';
import { digest } from './checksum';
import { coordinatedUpload } from './coordinator';
import { saveFirBackup } from './storage';

export interface FirBackup {
  format: 'fusion-studio-fir-backup';
  version: 1;
  id: string;
  utc: string;
  serial: string;
  product: number;
  firmware: string;
  preset: number;
  status_hex: string;
  name: string;
  sectors: { address: number; hex: string; sha256: string }[];
  filenames: { address: number; hex: string }[];
  sha256: string;
}
export type SaveFirBackup = (backup: FirBackup) => Promise<void>;
export interface FirPlan {
  backup: FirBackup;
  sectors: { address: number; bytes: Uint8Array }[];
  filenames: { address: number; bytes: Uint8Array }[];
  flags: number;
  placement: 0 | 1;
}
export function firLayout(preset: number) {
  if (![1, 2, 3].includes(preset)) throw new Error('Invalid FIR preset');
  const base = 0x10000 + (preset - 1) * 0x6000,
    names = 0x200 + (preset - 1) * 0x80;
  return {
    base,
    outputs: [base, base + 0x2000, base + 0x4000],
    sectors: Array.from({ length: 6 }, (_, i) => base + i * 4096),
    names: [names, names + 32, names + 64, names + 96],
  };
}
export function firPlacement(p: Preset): 'input' | 'output' {
  return presetFirPlacement(p);
}
export function encodeFir(taps: number[], count: number) {
  if (taps.length !== count || !taps.every(Number.isFinite) || taps.every((t) => t === 0))
    throw new Error(`Expected ${count} finite FIR taps with a nonzero response`);
  const b = new Uint8Array(count * 4),
    v = new DataView(b.buffer);
  taps.forEach((_, i) => v.setInt32(i * 4, q24(taps[count - 1 - i]), true));
  return b;
}
const encodeName = (name: string) => {
  const b = new Uint8Array(32),
    base = name.split(/[\\/]/).pop() ?? '';
  Array.from(base.slice(0, 31)).forEach((s, i) => (b[i] = Math.min(255, s.charCodeAt(0))));
  return b;
};
const manifest = (b: FirBackup) =>
  new TextEncoder().encode(
    JSON.stringify({
      serial: b.serial,
      product: b.product,
      firmware: b.firmware,
      preset: b.preset,
      status: b.status_hex,
      name: b.name,
      sectors: b.sectors,
      filenames: b.filenames,
    }),
  );
export async function backupFirInternal(
  session: PanelSession,
  preset: number,
  save: SaveFirBackup = saveFirBackup,
) {
  const layout = firLayout(preset),
    identity = await session.identifyInternal(),
    status = await session.statusInternal();
  const b: FirBackup = {
    format: 'fusion-studio-fir-backup',
    version: 1,
    id: uid(),
    utc: new Date().toISOString(),
    serial: identity.serial,
    product: identity.product,
    firmware: identity.firmware,
    preset,
    status_hex: hex(status.raw),
    name: identity.name,
    sectors: [],
    filenames: [],
    sha256: '',
  };
  for (const address of layout.sectors) {
    const bytes = await session.readMemoryInternal(address, 4096);
    b.sectors.push({ address, hex: hex(bytes), sha256: await digest(bytes) });
  }
  for (const address of layout.names)
    b.filenames.push({ address, hex: hex(await session.readMemoryInternal(address, 32, 0)) });
  b.sha256 = await digest(manifest(b));
  await save(b);
  return b;
}
export async function prepareFirInternal(
  session: PanelSession,
  preset: number,
  design: Preset,
  save?: SaveFirBackup,
): Promise<FirPlan | undefined> {
  const snapshot = structuredClone(design),
    activation = planFirActivation(snapshot, 0),
    placement = activation.placement,
    layout = firLayout(preset),
    loaded = activation.banks.map((bank) => bank.filter);
  const encoded = activation.banks.map((bank) =>
    bank.loaded ? encodeFir(bank.filter.taps, bank.capacity) : undefined,
  );
  const identity = await session.identifyInternal(),
    status = await session.statusInternal();
  await session.assertOperationsInternal('uploadFilters');
  if (encoded.some(Boolean)) {
    const config = unhex(identity.configuration),
      v = new DataView(config.buffer);
    if (
      !(config[14] & 128) ||
      v.getUint16(50, true) !== 4500 ||
      [52, 54, 56].some((i) => v.getUint16(i, true) !== 1500) ||
      settings(status).firMode !== 0
    )
      throw new Error('FIR upload requires the recovered ordinary 4500/1500-tap DSP mode');
  }
  const previous = status.raw[27 + preset];
  const flags = planFirActivation(snapshot, previous).flags;
  if (
    !encoded.some(Boolean) &&
    flags === previous &&
    ((status.raw[31] >> (preset - 1)) & 1) === placement
  )
    return;
  const backup = await backupFirInternal(session, preset, save),
    image = new Uint8Array(0x6000);
  backup.sectors.forEach((s, i) => image.set(unhex(s.hex), i * 4096));
  const touched = new Set<number>(),
    filenames: FirPlan['filenames'] = [];
  encoded.forEach((bytes, i) => {
    if (!bytes) return;
    const offset = placement === 0 ? 0 : i * 0x2000;
    image.set(bytes, offset);
    for (let o = offset; o < offset + bytes.length; o += 4096) touched.add(Math.floor(o / 4096));
    filenames.push({
      address: layout.names[placement === 0 ? 0 : i + 1],
      bytes: encodeName(loaded[i].name),
    });
  });
  return {
    backup,
    sectors: [...touched].sort().map((i) => ({
      address: layout.base + i * 4096,
      bytes: image.slice(i * 4096, (i + 1) * 4096),
    })),
    filenames,
    flags,
    placement: placement as 0 | 1,
  };
}
export async function writeFirNameInternal(
  session: PanelSession,
  address: number,
  bytes: Uint8Array,
) {
  if (address < 0x200 || address > 0x360 || address % 32 || bytes.length !== 32)
    throw new Error('Invalid FIR filename address');
  const status = await session.assertOperationsInternal('uploadFilters');
  if (!status.muted) throw new Error('FIR filename writes require verified mute');
  for (const request of [
    packet(0x64, 0, ...addr(address), 0),
    packet(0x64, 1, 32, ...bytes),
    packet(0x64, 2, 0),
  ])
    await session.ack(request);
  if (hex(await session.readMemoryInternal(address, 32, 0)) !== hex(bytes))
    throw new Error('FIR filename readback mismatch');
}
export async function programFirInternal(
  session: PanelSession,
  preset: number,
  plan: FirPlan,
  progress: Progress = () => {},
) {
  await session.assertOperationsInternal('uploadFilters');
  for (const [i, s] of plan.sectors.entries())
    await session.writeSectorInternal(s.address, s.bytes, (n, m) =>
      progress(((i + n / 100) / (plan.sectors.length + 1)) * 100, `FIR · ${m}`),
    );
  for (const f of plan.filenames) await writeFirNameInternal(session, f.address, f.bytes);
  const fresh = await session.assertOperationsInternal('uploadFilters'),
    inactiveEnabled = plan.placement === 0 ? 7 : 8,
    flags = (plan.flags & ~inactiveEnabled) | (fresh.raw[27 + preset] & inactiveEnabled);
  await session.controlsInternal({
    mute: true,
    presetFir: { preset, flags, placement: plan.placement },
  });
  progress(100, 'FIR bytes, filenames and activation verified · muted');
}
export async function uploadFir(
  session: PanelSession,
  preset: number,
  design: Preset,
  progress: Progress = () => {},
  save?: SaveFirBackup,
) {
  return session.exclusive(async () => {
    const plan = await prepareFirInternal(session, preset, design, save);
    if (!plan) return;
    await session.controlsInternal({ mute: true });
    await programFirInternal(session, preset, plan, progress);
    return plan.backup;
  });
}
export async function uploadFirPair(
  jobs: {
    session: PanelSession;
    preset: number;
    design: Preset;
    progress?: Progress;
    label?: string;
  }[],
) {
  return coordinatedUpload(
    jobs.map((j) => ({
      session: j.session,
      label: j.label,
      prepare: () => prepareFirInternal(j.session, j.preset, j.design),
      program: async (plan: FirPlan | undefined) => {
        if (plan) await programFirInternal(j.session, j.preset, plan, j.progress);
      },
    })),
  );
}
export async function readFir(session: PanelSession, preset: number, save?: SaveFirBackup) {
  return session.exclusive(async () => {
    const backup = await backupFirInternal(session, preset, save),
      status = decodeStatus(unhex(backup.status_hex)),
      layout = firLayout(preset),
      output = !!(status.raw[31] & (1 << (preset - 1))),
      flags = status.raw[27 + preset],
      image = new Uint8Array(0x6000);
    backup.sectors.forEach((s, i) => image.set(unhex(s.hex), i * 4096));
    const v = new DataView(image.buffer),
      decode = (i: number): Fir => {
        const bit = output ? i : 3,
          nameIndex = output ? i + 1 : 0,
          count = output ? 1500 : 4500,
          offset = output ? i * 8192 : 0;
        return {
          name: new TextDecoder('latin1')
            .decode(unhex(backup.filenames[nameIndex].hex))
            .replace(/\0.*$/s, ''),
          enabled: !!(flags & (1 << bit)),
          hfdState: { loaded: !!(flags & (1 << (bit + 4))), used: true, tapCount: count },
          taps:
            flags & (1 << (bit + 4))
              ? Array.from(
                  { length: count },
                  (_, j) => v.getInt32(offset + (count - 1 - j) * 4, true) / 2 ** 24,
                )
              : [],
        };
      };
    return {
      backup,
      flags,
      placement: output ? ('output' as const) : ('input' as const),
      filters: Array.from({ length: output ? 3 : 1 }, (_, i) => decode(i)),
    };
  });
}
export async function restoreFir(
  session: PanelSession,
  backup: FirBackup,
  progress: Progress = () => {},
  save?: SaveFirBackup,
) {
  return session.exclusive(async () => {
    const identity = await session.identifyInternal(),
      layout = firLayout(backup.preset);
    if (
      backup.format !== 'fusion-studio-fir-backup' ||
      backup.version !== 1 ||
      backup.serial !== identity.serial ||
      backup.product !== identity.product ||
      backup.firmware !== identity.firmware ||
      backup.sha256 !== (await digest(manifest(backup))) ||
      backup.sectors.length !== 6 ||
      backup.filenames.length !== 4
    )
      throw new Error('FIR backup identity or manifest checksum mismatch');
    for (const [i, s] of backup.sectors.entries())
      if (
        s.address !== layout.sectors[i] ||
        unhex(s.hex).length !== 4096 ||
        (await digest(unhex(s.hex))) !== s.sha256
      )
        throw new Error('Invalid FIR sector backup');
    for (const [i, f] of backup.filenames.entries())
      if (f.address !== layout.names[i] || unhex(f.hex).length !== 32)
        throw new Error('Invalid FIR filename backup');
    const original = decodeStatus(unhex(backup.status_hex));
    await session.assertOperationsInternal('uploadFilters');
    await backupFirInternal(session, backup.preset, save);
    await session.controlsInternal({ mute: true });
    await programFirInternal(
      session,
      backup.preset,
      {
        backup,
        sectors: backup.sectors.map((s) => ({ address: s.address, bytes: unhex(s.hex) })),
        filenames: backup.filenames.map((f) => ({ address: f.address, bytes: unhex(f.hex) })),
        flags: original.raw[27 + backup.preset],
        placement: ((original.raw[31] >> (backup.preset - 1)) & 1) as 0 | 1,
      },
      progress,
    );
    await session.setNameInternal(backup.name);
    await session.controlsInternal({ mute: true, preset: original.preset });
  });
}
