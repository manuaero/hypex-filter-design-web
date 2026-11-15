import type { Filter } from '../domain/model';
import { decodeEq, decodeStatus, encodeEq, presetBase, unhex } from './codec';
import { coordinatedUpload } from './coordinator';
import type { ProjectUploadResult } from './project-upload';
import type { Identity, PanelSession, Progress } from './session';

/** Array order is device preset 1, 2, 3. Each record contains nine bands. */
export interface EqBankRecord {
  bands: Filter[];
  enabled: boolean;
}

export interface EqBankUploadJob {
  session: PanelSession;
  bank: EqBankRecord[];
  /** Native Save-to-all copies pages while retaining each live activation flag.
   * Default false applies the clipboard bank's explicit enabled states. */
  preserveActivation?: boolean;
  label?: string;
  progress?: Progress;
}

/** Several EQ sectors are not an atomic transaction. Results distinguish the
 * verified records from a failed record and records that were never attempted. */
export class EqBankUploadError extends Error {
  readonly results: ProjectUploadResult[];
  constructor(results: ProjectUploadResult[], cause: unknown, programmingStarted: boolean) {
    const summary = results
      .map(
        (r) =>
          `${r.label}: ${r.presets
            .map((p) => `preset ${p.preset} ${p.state}${p.error ? ` (${p.error})` : ''}`)
            .join(', ')}${r.error ? `; ${r.error}` : ''}`,
      )
      .join(' · ');
    super(
      `${programmingStarted ? 'EQ bank upload incomplete' : 'Nothing programmed'} — ${summary}. ${String(cause)}. No automatic rollback was performed.`,
      { cause },
    );
    this.name = 'EqBankUploadError';
    this.results = structuredClone(results);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameIdentity = (
  expected: Pick<Identity, 'serial' | 'product' | 'firmware'>,
  actual: Pick<Identity, 'serial' | 'product' | 'firmware'>,
) =>
  expected.serial === actual.serial &&
  expected.product === actual.product &&
  expected.firmware === actual.firmware;

/** Read and persist exact backups of all three input EQ sectors under a single
 * session reservation. No control, preset-selection, reload or flash write is
 * issued. Returned filters are detached from both transport memory and backups.
 * The final fresh status supplies all three enable flags without selecting any
 * preset. Reads remain available on a password-locked panel. */
export async function readEqBank(session: PanelSession): Promise<EqBankRecord[]> {
  return session.exclusive(async () => {
    const identity = { ...(await session.identifyInternal()) };
    await session.statusInternal();
    const bands: Filter[][] = [];
    for (const preset of [1, 2, 3]) {
      const backup = await session.backupInternal(preset, presetBase(preset) + 0x3000);
      if (!sameIdentity(identity, backup))
        throw new Error('Amplifier identity or firmware changed while reading the EQ bank');
      bands.push(decodeEq(unhex(backup.sector_hex)));
    }
    if (!sameIdentity(identity, await session.identifyInternal()))
      throw new Error('Amplifier identity or firmware changed while reading the EQ bank');
    const status = await session.statusInternal();
    return bands.map((record, i) => ({ bands: record, enabled: !!(status.raw[12 + i] & 16) }));
  });
}

function validateRecord(record: EqBankRecord) {
  if (!record || typeof record.enabled !== 'boolean' || !Array.isArray(record.bands))
    throw new Error('An EQ bank record requires bands and a boolean enabled flag');
  // encodeEq validates device ranges and quantized stability. Its disabled-band
  // unity path must not allow non-finite saved metadata to become integer zero.
  if (
    record.bands.some(
      (f) =>
        !f || typeof f.enabled !== 'boolean' || ![f.frequency, f.q, f.gain].every(Number.isFinite),
    )
  )
    throw new Error(
      'EQ bands require finite frequency, Q and gain metadata and boolean enable flags',
    );
  encodeEq(record.bands);
}

type EqPlan = Awaited<ReturnType<PanelSession['prepareEqInternal']>>;
interface BankPlan {
  identity: Identity;
  startingPreset: number;
  records: EqPlan[];
}

/** Upload exactly three EQ records to one or two FA503 panels. All participants
 * are reserved once; every record is validated, and all affected full sectors
 * plus shared configuration/status are durably backed up before the common mute
 * barrier. Each panel programs sequentially while panels run concurrently.
 * Active preset and unrelated status flags are preserved; success retains mute.
 * Partial failure retains the verified records and does not attempt rollback. */
export async function uploadEqBankPair(jobs: EqBankUploadJob[]): Promise<void> {
  if (jobs.length < 1 || jobs.length > 2)
    throw new Error('EQ bank upload requires one or two amplifiers');
  if (new Set(jobs.map((j) => j.session)).size !== jobs.length)
    throw new Error('Each role requires a distinct amplifier');
  for (const job of jobs) {
    if (!Array.isArray(job.bank) || job.bank.length !== 3)
      throw new Error('An EQ bank upload requires exactly three records per amplifier');
    if (job.preserveActivation !== undefined && typeof job.preserveActivation !== 'boolean')
      throw new Error('preserveActivation must be a boolean');
  }

  const participants = jobs.map((job, i) => ({
    ...job,
    bank: structuredClone(job.bank),
    label: job.label ?? (jobs.length === 1 ? 'Amplifier' : i === 0 ? 'Left' : 'Right'),
  }));
  const results: ProjectUploadResult[] = participants.map((j) => ({
    label: j.label,
    presets: [1, 2, 3].map((preset) => ({ preset, state: 'pending' })),
    activePresetRestored: false,
    lastConfirmedMuted: false,
  }));
  let programmingStarted = false;
  const report = (i: number, percent: number, text: string) => {
    try {
      participants[i].progress?.(percent, `${participants[i].label} · ${text}`);
    } catch {
      // A view observer must not interrupt a multi-sector hardware operation.
    }
  };
  const failPreset = (i: number, p: number, phase: 'preflight' | 'program', error: unknown) =>
    Object.assign(results[i].presets[p], { state: 'failed', phase, error: message(error) });

  try {
    await coordinatedUpload<BankPlan>(
      participants.map((job, i) => ({
        session: job.session,
        label: job.label,
        prepare: async () => {
          const result = results[i];
          try {
            for (const [p, record] of job.bank.entries()) {
              try {
                validateRecord(record);
              } catch (error) {
                failPreset(i, p, 'preflight', error);
                throw error;
              }
            }
            report(i, 0, 'Backing up shared configuration and all three EQ presets');
            const shared = await job.session.backupConfigurationInternal(),
              identity = { ...job.session.identity! },
              startingStatus = decodeStatus(unhex(shared.status_hex));
            result.serial = identity.serial;
            result.startingPreset = startingStatus.preset;
            await job.session.assertOperationsInternal('equalizer');
            const records: EqPlan[] = [];
            for (const [p, record] of job.bank.entries()) {
              try {
                const plan = await job.session.prepareEqInternal(
                  p + 1,
                  record.bands,
                  record.enabled,
                );
                if (
                  !sameIdentity(identity, shared) ||
                  !sameIdentity(identity, plan.backup) ||
                  !sameIdentity(identity, job.session.identity!)
                )
                  throw new Error('Amplifier identity or firmware changed during EQ preparation');
                records.push(plan);
                report(i, ((p + 1) / 3) * 10, `EQ preset ${p + 1}/3 · validated and backed up`);
              } catch (error) {
                failPreset(i, p, 'preflight', error);
                throw error;
              }
            }
            // A panel can disappear or be replaced while the last durable
            // backup is being saved. Confirm the same panel before the common
            // mute barrier, rather than first discovering that during program.
            if (!sameIdentity(identity, await job.session.identifyInternal()))
              throw new Error('Amplifier identity or firmware changed during EQ preparation');
            await job.session.assertOperationsInternal('equalizer');
            return { identity, startingPreset: startingStatus.preset, records };
          } catch (error) {
            result.error = message(error);
            throw error;
          }
        },
        program: async (plan) => {
          programmingStarted = true;
          const result = results[i];
          try {
            for (const [p, record] of plan.records.entries()) {
              try {
                if (!sameIdentity(plan.identity, await job.session.identifyInternal()))
                  throw new Error('Amplifier identity or firmware changed before EQ programming');
                const status = await job.session.assertOperationsInternal('equalizer');
                if (!status.muted) throw new Error('Panel must remain muted during EQ bank upload');
                report(i, 10 + p * 28, `EQ preset ${p + 1}/3 · programming`);
                const enabled = job.preserveActivation
                  ? !!(status.raw[12 + p] & 16)
                  : record.enabled;
                await job.session.programEqInternal(p + 1, record.target, enabled, (n, text) =>
                  report(
                    i,
                    10 + (p + Math.min(0.99, n / 100)) * 28,
                    `EQ preset ${p + 1}/3 · ${text}`,
                  ),
                );
                result.presets[p].state = 'verified';
                result.presets[p].phase = 'program';
                report(i, 10 + (p + 1) * 28, `EQ preset ${p + 1}/3 · verified · muted`);
              } catch (error) {
                failPreset(i, p, 'program', error);
                throw error;
              }
            }
            await job.session.controlsInternal({ mute: true, preset: plan.startingPreset });
            result.activePresetRestored = true;
            report(
              i,
              100,
              `All three EQ presets verified · preset ${plan.startingPreset} retained · muted`,
            );
          } catch (error) {
            result.error = message(error);
            throw error;
          }
        },
      })),
    );
  } catch (error) {
    results.forEach((r, i) => {
      r.lastConfirmedMuted = participants[i].session.lastStatus?.muted === true;
    });
    throw new EqBankUploadError(results, error, programmingStarted);
  }
}
