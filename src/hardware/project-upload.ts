import { compileSector } from '../domain/dsp';
import type { Preset } from '../domain/model';
import { planFirActivation } from '../domain/fir-state';
import { decodeStatus, unhex } from './codec';
import { coordinatedUpload } from './coordinator';
import { backupFirInternal, firPlacement, type FirPlan } from './fir';
import type { Identity, PanelSession, Progress } from './session';

export interface ProjectUploadJob {
  session: PanelSession;
  name: string;
  presets: Preset[];
  progress?: Progress;
  label?: string;
}

export interface ProjectPresetUploadResult {
  preset: number;
  state: 'pending' | 'verified' | 'failed';
  phase?: 'preflight' | 'program';
  error?: string;
  firPlacement?: 'input' | 'output';
  firWarnings?: string[];
}

export interface ProjectUploadResult {
  label: string;
  serial?: string;
  presets: ProjectPresetUploadResult[];
  startingPreset?: number;
  activePresetRestored: boolean;
  /** The most recent status reply, rather than a promise about a disconnected panel. */
  lastConfirmedMuted: boolean;
  error?: string;
}

/** Programming several sectors is not atomic. These results identify what was
 * verified before a failure; exact saved backups remain available for recovery. */
export class ProjectUploadError extends Error {
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
      `${programmingStarted ? 'Project upload incomplete' : 'Nothing programmed'} — ${summary}. ${String(cause)}. No automatic rollback was performed.`,
      { cause },
    );
    this.name = 'ProjectUploadError';
    this.results = structuredClone(results);
  }
}

type PresetPlan = Awaited<ReturnType<PanelSession['prepareInternal']>> & { fir: FirPlan };
interface ProjectPlan {
  identity: Identity;
  startingPreset: number;
  presets: PresetPlan[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameIdentity = (
  expected: Pick<Identity, 'serial' | 'product' | 'firmware'>,
  actual: Pick<Identity, 'serial' | 'product' | 'firmware'>,
) =>
  expected.serial === actual.serial &&
  expected.product === actual.product &&
  expected.firmware === actual.firmware;

/** Upload the three IIR/FIR presets on one or two panels. Input EQ is a separate
 * device operation. Every participant is reserved for the complete operation;
 * all IIR sectors, full FIR banks, EEPROM filenames and shared configuration /
 * status records are durably backed up before the first mute or programming
 * request. Success restores each panel's starting preset and retains global mute.
 * A failure stops that panel's remaining presets, while the other panel finishes
 * its own sequence. There is deliberately no automatic rollback claim. */
export async function uploadProjectPair(jobs: ProjectUploadJob[]): Promise<void> {
  if (jobs.length < 1 || jobs.length > 2)
    throw new Error('Project upload requires one or two amplifiers');
  if (new Set(jobs.map((j) => j.session)).size !== jobs.length)
    throw new Error('Each role requires a distinct amplifier');
  for (const job of jobs) {
    if (typeof job.name !== 'string') throw new Error('A project upload requires a name');
    if (!Array.isArray(job.presets) || job.presets.length !== 3)
      throw new Error('A project upload requires exactly three presets per amplifier');
  }

  // Freeze design inputs before any await. A UI edit during backup cannot alter
  // a later preset or make the two roles share a mutable design instance.
  const participants = jobs.map((job, i) => ({
    ...job,
    presets: structuredClone(job.presets),
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
    // A view observer must not interrupt a multi-sector hardware operation.
    try {
      participants[i].progress?.(percent, `${participants[i].label} · ${text}`);
    } catch {
      // Progress is informational; protocol verification remains authoritative.
    }
  };

  try {
    await coordinatedUpload<ProjectPlan>(
      participants.map((job, i) => ({
        session: job.session,
        label: job.label,
        prepare: async () => {
          const result = results[i];
          try {
            // Compile all three before doing any device preparation. FIR's
            // complete validation is also performed by prepareInternal below.
            for (const [p, design] of job.presets.entries()) {
              try {
                compileSector(design, new Uint8Array(4096));
                const activation = planFirActivation(design, 0);
                result.presets[p].firPlacement = activation.placement === 0 ? 'input' : 'output';
                result.presets[p].firWarnings = activation.warnings;
                for (const warning of activation.warnings)
                  report(i, 0, `Preset ${p + 1}/3 · ${warning}`);
              } catch (error) {
                Object.assign(result.presets[p], {
                  state: 'failed',
                  phase: 'preflight',
                  error: message(error),
                });
                throw error;
              }
            }
            report(i, 0, 'Backing up shared configuration and all three presets');
            const shared = await job.session.backupConfigurationInternal(),
              identity = { ...job.session.identity! },
              startingStatus = decodeStatus(unhex(shared.status_hex));
            result.serial = identity.serial;
            result.startingPreset = startingStatus.preset;
            await job.session.assertOperationsInternal('uploadFilters');
            const presets: PresetPlan[] = [];
            for (const [p, design] of job.presets.entries()) {
              try {
                const preset = p + 1,
                  plan = await job.session.prepareInternal(preset, design),
                  firBackup = plan.fir?.backup ?? (await backupFirInternal(job.session, preset));
                if (
                  !sameIdentity(identity, shared) ||
                  !sameIdentity(identity, plan.backup) ||
                  !sameIdentity(identity, firBackup) ||
                  !sameIdentity(identity, job.session.identity!)
                )
                  throw new Error('Amplifier identity or firmware changed during preparation');
                // Even an unchanged FIR needs an exact backup and explicit
                // activation plan in an all-presets upload.
                const fir = plan.fir ?? {
                  backup: firBackup,
                  sectors: [],
                  filenames: [],
                  flags: decodeStatus(unhex(firBackup.status_hex)).raw[27 + preset],
                  placement: (firPlacement(design) === 'input' ? 0 : 1) as 0 | 1,
                };
                presets.push({ ...plan, fir });
                report(i, ((p + 1) / 3) * 10, `Preset ${preset}/3 · validated and backed up`);
              } catch (error) {
                Object.assign(result.presets[p], {
                  state: 'failed',
                  phase: 'preflight',
                  error: message(error),
                });
                throw error;
              }
            }
            return { identity, startingPreset: startingStatus.preset, presets };
          } catch (error) {
            result.error = message(error);
            throw error;
          }
        },
        program: async (plan) => {
          programmingStarted = true;
          const result = results[i];
          try {
            for (const [p, presetPlan] of plan.presets.entries()) {
              const preset = p + 1;
              try {
                const identity = await job.session.identifyInternal();
                if (!sameIdentity(plan.identity, identity))
                  throw new Error('Amplifier identity or firmware changed before programming');
                const state = await job.session.assertOperationsInternal('uploadFilters');
                if (!state.muted) throw new Error('Panel must remain muted during project upload');
                const design = job.presets[p],
                  fir = { ...presetPlan.fir };
                // Match prepareFirInternal's ownership of activation bits, but
                // preserve the other placement's bits from the latest reply.
                // controlsInternal separately merges the other presets' shared
                // status/placement fields against a fresh reply on every write.
                fir.flags = planFirActivation(design, state.raw[27 + preset]).flags;
                const firWeight = fir.sectors.length + 1,
                  totalWeight = firWeight + 1;
                let fraction = 0;
                report(i, 10 + p * 28, `Preset ${preset}/3 · programming`);
                await job.session.programInternal(
                  preset,
                  job.name,
                  presetPlan.target,
                  (percent, text) => {
                    const firMessage = text.startsWith('FIR'),
                      next = firMessage
                        ? (percent / 100) * (firWeight / totalWeight)
                        : (firWeight + percent / 100) / totalWeight;
                    // The preset is only verified after programInternal returns.
                    fraction = Math.max(fraction, Math.min(0.99, next));
                    report(i, 10 + (p + fraction) * 28, `Preset ${preset}/3 · ${text}`);
                  },
                  fir,
                );
                result.presets[p].state = 'verified';
                result.presets[p].phase = 'program';
                report(i, 10 + (p + 1) * 28, `Preset ${preset}/3 · verified · muted`);
              } catch (error) {
                Object.assign(result.presets[p], {
                  state: 'failed',
                  phase: 'program',
                  error: message(error),
                });
                throw error;
              }
            }
            await job.session.controlsInternal({ mute: true, preset: plan.startingPreset });
            result.activePresetRestored = true;
            report(
              i,
              100,
              `All three presets verified · preset ${plan.startingPreset} restored · muted`,
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
    throw new ProjectUploadError(results, error, programmingStarted);
  }
}
