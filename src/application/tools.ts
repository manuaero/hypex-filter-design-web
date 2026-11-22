import {
  resetInputEq,
  copyInputEqToPresets,
  snapshotEqBank,
  applyEqBank,
  editInputEqBand,
  type EqBank,
} from '../domain/equalizer';
import { readEqBank, uploadEqBankPair, EqBankUploadError } from '../hardware/eq-bank';
import { uploadProjectPair, ProjectUploadError } from '../hardware/project-upload';
import {
  exchangeBiquads,
  copyChannelProcessing,
  clearPreset,
  deleteBiquad,
  isUnusedBiquad,
  editManualFilter,
  planManualFilterWheel,
  applyManualFilterWheel,
} from '../domain/editing';
import { copyPresetBetween } from '../domain/preset-copy';
import { planChannelEdit, applyChannelEdit } from '../domain/channel-editing';
import type { ChannelDelayRuntime } from '../domain/channel-delay-profile';
import {
  editPresetFir,
  applyNativeFirAction,
  selectNativeFirPlacement,
  applyReadFir,
} from '../domain/fir-editing';
import { importProjectFolderOpen, projectFiles } from '../domain/project-io';
import { parseProjectOpen } from '../domain/project-open';
import type { ProjectReplacementIntent } from './native-project-open';
import { linkChannel, rootChannel, assertProjectLinks } from '../domain/links';
import { readFir, uploadFirPair, restoreFir } from '../hardware/fir';
import { planFirActivation } from '../domain/fir-state';
import {
  spectrum,
  parseImpulse,
  decodeWav,
  processMeasurement,
  resetMeasurementProcessing,
} from '../domain/measurement';
import { z } from 'zod';
import { hfdInputEqWheelNext, formatHfdInputEqValue } from '../domain/input-eq-parameters';
import {
  type Slot,
  type Channel,
  type Filter,
  type Project,
  type HfdProjectCalibration,
  newFilter,
  newProject,
  FS,
  HFD_INDEX_MIN,
  HFD_INDEX_MAX,
} from '../domain/model';
import {
  projectSchema,
  parseFir,
  parseMeasurement,
  exportHfd,
  resolveGainCache,
} from '../domain/files';
import { presetResponse, encodeChannel, FILTER_NAMES, design, response } from '../domain/dsp';
import { analyzeTimeResponses } from '../domain/time-analysis';
import { inputEqAnalysisChannel } from '../domain/input-eq-analysis';
import { fitTimeSeries, plotTimeSeries } from '../domain/time-series';
import {
  useHfdNative,
  useBrowserMeasurement,
  updateHfdMeasurement,
  processChannelMeasurement,
  enablePresetHfdMeasurement,
  setSharedHfdCrop,
  hfdMeasurementStatus,
  importChannelMeasurement,
  clearHfdCapture,
  reconcileProjectHfdCalibration,
} from '../domain/hfd-measurement';
import { truncateHfdVisibleRange } from '../domain/hfd-truncate';
import {
  loadProjectMicrophone,
  unloadProjectMicrophone,
  setProjectMicrophoneOptions,
  inheritProjectMicrophone,
  projectMicrophoneStatus,
} from '../domain/hfd-microphone';
import { buildHfdResponseView, sampleHfdView } from '../domain/hfd-response-view';
import { prepareNativeElectricalView } from '../domain/native-electrical-view';
import { buildMagnitudeLayers } from '../domain/plot-layers';
import type { GraphViewPatch } from './graph-view';
import { NoiseControlError, type NoiseController } from './noise-control';
import { DirectorySaveError, type ProjectDirectoryWriter } from './project-directory-writer';
import type { DirectoryLegacyAccess, DirectoryLegacyReview } from './workspace-directory';
import { directoryProposalPage, directorySnapshotPage } from './directory-save-view';
import { createRecoveryZip } from './recovery-archive';
import { getHelpResources } from './help-resources';
import { INPUT_SOURCES, MAX_INPUT_SOURCE, FUTURE_INPUT_NOTE } from '../hardware/input-sources';
import {
  ProjectSourcesError,
  type ProjectSources,
  type ProjectOpenResult,
} from './project-sources';
import { importBackupFile } from '../hardware/backup-file';
import { parseExecutionPrincipal, type ToolExecutionContext } from './execution-context';
import {
  captureConfigSchema,
  captureRequestSchema,
  type CaptureController,
  type CaptureSnapshot,
} from './measurement-capture';
import type { FirmwareWorkspace } from './firmware-workspace';
import { FirmwareRuntimeDiagnosticError, type FirmwareRuntimeController } from './firmware-runtime';
import {
  captureManualFilterDrag,
  planManualFilterDrag,
  applyManualFilterDrag,
} from '../domain/graph-drag';
import { FirmwareExecutionError, type FirmwareExecutionWorkflow } from './firmware-execution';
import { DeviceAuthOperationError, type DeviceAuthController } from './device-auth';
import { DeviceDefaultsError, type DeviceDefaultsController } from './device-defaults';
import { AmplifierModesError, type AmplifierModesController } from './amplifier-modes';
import { amplifierModesToolSchema, executeAmplifierModesTool } from './amplifier-modes-tools';
import { nativeMixerToolSchema, executeNativeMixerTool } from './native-mixer-tools';
import { NativeMixerError, type NativeMixerController } from './native-mixer';
import {
  DeviceCloneError,
  deviceCloneRecordSummary,
  type DeviceCloneController,
} from './device-clone';
import { deviceCloneToolSchema, executeDeviceCloneTool } from './device-clone-tools';
import { deviceDefaultsRecordSummary, deviceDefaultsSnapshotPage } from './device-defaults-view';
import {
  NativeLimiterError,
  nativeLimiterSnapshotPage,
  type NativeLimiterController,
  type NativeLimiterEditAction,
} from './native-limiter';
import { PasswordRecoveryError } from './password-recovery';
import { credentialInputSchema } from '../domain/credential-encoding';
import type { UsbDescriptorVerifier } from '../hardware/usb-descriptor';
import { MAX_UI_TEXT_CHARACTERS } from './file-budget';
import {
  type FileTransfers,
  type FileTransferStatus,
  type TransferJson,
  FILE_TRANSFER_CHUNK_BYTES,
  FILE_TRANSFER_MAX_FILE_BYTES,
} from './file-transfers';
import {
  ImportWorkflowSchema,
  ExportWorkflowSchema,
  prepareFileImport,
  prepareFileExport,
} from './file-workflows';
import type { NativeProjectSaveController } from './native-project-save';
import type { AmplifierDiscoveryController } from './amplifier-discovery';
import {
  type PanelSession,
  type Identity,
  type Backup,
  uploadPair,
  uploadEqPair,
} from '../hardware/session';
import { type PanelStatus, type Controls, hex, settings, encodeEq } from '../hardware/codec';
import { decodeMetering } from '../hardware/metering';
import { decodeHealth } from '../hardware/health';
import { dspPowerOffAvailability } from '../hardware/power-availability';
import {
  listBackups,
  listConfigurationBackups,
  listFirBackups,
  saveProject,
  listProjects,
  trashProject,
  getProject,
} from '../hardware/storage';
export interface DocumentState {
  documents: Record<Slot, Project>;
  slot: Slot;
  preset: number;
  channel: number;
  filter: number;
  linkedEdits: boolean;
  linkedControls: boolean;
  rememberedHfdCalibration?: HfdProjectCalibration;
  documentRevision?: number;
}
export interface HardwareGainEditorLocation {
  slot: Slot;
  presetIndex: number;
  channelIndex: number;
  channelId: string;
}
export interface ToolAdapter {
  state: () => DocumentState;
  edit: (slots: Slot[], fn: (p: Project) => void, options?: { synchronizeLinks?: boolean }) => void;
  editByRole?: (
    slots: Slot[],
    fn: (project: Project, slot: Slot) => void,
    options?: { synchronizeLinks?: boolean },
  ) => void;
  /** Trusted retained native view context; command JSON cannot supply eligibility. */
  hardwareGainContext?: (
    location: Omit<HardwareGainEditorLocation, 'channelId'>,
  ) => { available: boolean; gainText?: string } | undefined;
  /** Current session and visible Global Text; never accepted from command JSON. */
  delayContext?: (
    location: Omit<HardwareGainEditorLocation, 'channelId'>,
  ) => { runtime?: ChannelDelayRuntime; globalText?: string } | undefined;
  /** Called only after a fully admitted intent commits (including canonical no-op). */
  retainHardwareGainContexts?: (locations: readonly HardwareGainEditorLocation[]) => void;
  choose: (
    patch: Partial<
      Omit<DocumentState, 'documents' | 'rememberedHfdCalibration' | 'documentRevision'>
    >,
  ) => void;
  undo: () => void;
  redo: () => void;
  /** Pure trusted final-data preparation before any authoritative replacement. */
  prepareProjectOpen?: (project: Project, slot: Slot, intent: ProjectReplacementIntent) => Project;
  /** Explicit whole-project replacement invalidates saved view projections, even with identical IDs. */
  documentsReplaced?: (slots: readonly Slot[], intent?: ProjectReplacementIntent) => void;
  /** Presentation refresh after an actual Load/Clear; indexes are zero-based. */
  measurementsReplaced?: (
    slots: readonly Slot[],
    preset: number,
    channels: readonly number[],
  ) => void;
  connections: () => Partial<
    Record<Slot, { session: PanelSession; identity: Identity; status: PanelStatus }>
  >;
  connect: (slot: Slot, serial?: string) => Promise<void>;
  disconnect: (slot: Slot) => Promise<void>;
  refresh: (slots: Slot[]) => Promise<void>;
  operate: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  message: (message: string) => void;
  progress: (slot: Slot, percent: number, message: string) => void;
  palette?: (command: {
    action: 'open' | 'update' | 'apply' | 'cancel';
    mode?: 'add' | 'replace';
    index?: number;
    draft?: Partial<Filter>;
  }) => void | Promise<void>;
  microphone?: { remember: (reference: HfdProjectCalibration | undefined) => void };
  capture?: CaptureController;
  firmware?: FirmwareWorkspace;
  firmwareRuntime?: FirmwareRuntimeController;
  firmwareExecution?: FirmwareExecutionWorkflow;
  auth?: DeviceAuthController;
  deviceDefaults?: DeviceDefaultsController;
  deviceClone?: DeviceCloneController;
  nativeLimiter?: NativeLimiterController;
  amplifierModes?: AmplifierModesController;
  nativeMixer?: NativeMixerController;
  nativeProjectSave?: NativeProjectSaveController;
  amplifiers?: AmplifierDiscoveryController;
  readAmplifierProject?: (slot: Slot) => Promise<unknown>;
  descriptorVerifier?: UsbDescriptorVerifier;
  sources?: ProjectSources;
  directoryWriter?: ProjectDirectoryWriter & Partial<DirectoryLegacyAccess>;
  reviewDirectoryLegacy?: (review: DirectoryLegacyReview) => boolean;
  noise?: NoiseController;
  sourceOpen?: {
    status: () => {
      busy: boolean;
      pending?: {
        sourceId: string;
        target: Slot | 'both';
        expectedRevision: number;
        requestId: string;
      };
    };
    retry: () => Promise<ProjectOpenResult>;
    discard: () => void;
  };
  files?: {
    manager: FileTransfers;
    revision: () => number;
    commit: (
      commitId: string,
      context: { owner: string; scope: string },
      expectedRevision: number,
      slots: Slot[],
      apply: (project: Project) => void,
      result: TransferJson,
      remember?: (documents: Record<Slot, Project>) => HfdProjectCalibration | undefined,
      options?: { synchronizeLinks?: boolean },
    ) => Promise<TransferJson>;
    lookup: (commitId: string, owner: string) => Promise<TransferJson | undefined>;
  };
  eqClipboard?: {
    get: () => EqBank | undefined;
    set: (bank: EqBank, label: string) => void;
    clear: () => void;
    label: () => string;
  };
  persistence?: {
    status: () => unknown;
    retry: () => Promise<void>;
    flush: () => Promise<void>;
    recovery: () => string | null;
  };
  viewState?: () => unknown;
  view: (patch: {
    projectSavePanel?: boolean;
    noisePanel?: boolean;
    graph?: GraphViewPatch;
    healthDetails?: boolean;
    meters?: boolean;
    authPanel?: 'closed' | 'password' | 'permissions';
    expertBank?: boolean;
    designer?: 'graph' | 'chain';
    selectedBiquads?: number[];
    copySourceChannel?: number | null;
    tab?: string;
    mode?: string;
    sum?: boolean;
    measured?: boolean;
    measurementView?: 'frequency' | 'phase' | 'impulse';
    calibrationCurve?: boolean;
    nativeCentered?: boolean;
    showUnloadedFilters?: boolean;
    eqBand?: number;
    coefficients?: boolean;
    resetPlot?: boolean;
    zoomBack?: boolean;
    zoomRectangle?: boolean;
    frequencyMin?: number;
    frequencyMax?: number;
    dbMin?: number;
    dbMax?: number;
    timeMinMs?: number;
    timeMaxMs?: number;
    amplitudeMin?: number;
    amplitudeMax?: number;
    fitTime?: 'response' | 'truncated';
  }) => void;
}
const slot = z.enum(['left', 'right']),
  target = z.enum(['left', 'right', 'both']);
const preset = z.number().int().min(1).max(3),
  channel = z.number().int().min(1).max(3),
  index = z.number().int().min(1).max(15),
  finite = z.number().finite();
const publicCaptureConfig = captureConfigSchema.extend({
  inputChannel: z.number().int().min(1).max(256),
  outputChannel: z.number().int().min(1).max(256),
});
function publicCaptureSnapshot(snapshot: CaptureSnapshot): CaptureSnapshot {
  const publicTarget = (value: NonNullable<CaptureSnapshot['target']>) => ({
    ...value,
    preset: value.preset + 1,
    channel: value.channel + 1,
  });
  const receiptResult = snapshot.receipt?.result;
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      inputChannel: snapshot.config.inputChannel + 1,
      outputChannel: snapshot.config.outputChannel + 1,
    },
    ...(snapshot.target ? { target: publicTarget(snapshot.target) } : {}),
    ...(snapshot.receipt &&
    receiptResult &&
    typeof receiptResult === 'object' &&
    !Array.isArray(receiptResult) &&
    receiptResult.target
      ? {
          receipt: {
            ...snapshot.receipt,
            result: {
              ...receiptResult,
              target: publicTarget(
                receiptResult.target as unknown as NonNullable<CaptureSnapshot['target']>,
              ),
            },
          },
        }
      : {}),
  };
}
const FILE_TOOL_NAMES = [
  'fusion_file_upload_begin',
  'fusion_file_upload_chunk',
  'fusion_file_upload_commit',
  'fusion_file_export',
  'fusion_file_chunk_read',
  'fusion_file_status',
  'fusion_file_list',
  'fusion_file_close',
] as const;
const fileHandle = z.string().min(1).max(200);
const fileIndex = z.number().int().min(0).max(1999);
const chunkIndex = z
  .number()
  .int()
  .min(0)
  .max(Math.ceil(FILE_TRANSFER_MAX_FILE_BYTES / FILE_TRANSFER_CHUNK_BYTES));
const sha256 = z.string().regex(/^[a-f\d]{64}$/i);
const kinds = z.enum(Object.keys(FILTER_NAMES) as [Filter['kind'], ...Filter['kind'][]]);
const graphViewPatch = z
  .object({
    sum: z.boolean().optional(),
    measured: z.boolean().optional(),
    preset: z.enum(['hfd', 'outputs']).optional(),
    rawMeasurements: z.array(z.boolean()).length(3).optional(),
    currentResult: z.boolean().optional(),
    otherResults: z.boolean().optional(),
    section: z.boolean().optional(),
    sectionScope: z.enum(['selected', 'channel']).optional(),
    phase: z
      .object({ channels: z.array(z.boolean()).length(3).optional(), sum: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
const noiseAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('set'), enabled: z.boolean() }).strict(),
]);
const nativeFirAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('clear'),
      output: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    })
    .strict(),
  z.object({ kind: z.literal('placement'), placement: z.enum(['input', 'output']) }).strict(),
  z
    .object({
      kind: z.literal('enabled'),
      channel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      enabled: z.boolean(),
    })
    .strict(),
]);
const sourceId = z.string().regex(/^[a-zA-Z0-9._:-]{1,256}$/);
const sourceCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z
    .object({
      action: z.literal('list'),
      rootId: sourceId,
      sort: z
        .object({
          by: z.enum(['name', 'modified']),
          direction: z.enum(['ascending', 'descending']),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('open'),
      sourceId,
      target,
      expectedRevision: z.number().int().nonnegative(),
      requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
    })
    .strict(),
  z.object({ action: z.literal('reference'), id: sourceId }).strict(),
  z.object({ action: z.literal('select-root'), rootId: sourceId }).strict(),
  z.object({ action: z.literal('forget-recent'), sourceId }).strict(),
  z.object({ action: z.literal('clear-recent') }).strict(),
  z.object({ action: z.literal('forget-root'), rootId: sourceId }).strict(),
  z.object({ action: z.literal('retry') }).strict(),
  z.object({ action: z.literal('flush') }).strict(),
  z.object({ action: z.literal('retry-open') }).strict(),
  z.object({ action: z.literal('discard-open') }).strict(),
]);
const coefficients = z
  .object({ b0: finite, b1: finite, b2: finite, f1: finite, f2: finite })
  .strict();
const filterPatch = z
  .object({
    kind: kinds,
    enabled: z.boolean(),
    frequency: finite.positive().max(50000),
    q: finite.positive().max(100),
    gain: finite.min(-96).max(60),
    frequency2: finite.positive().max(50000),
    q2: finite.positive().max(100),
    shelfDirection: z.enum(['low', 'high']),
    coefficients,
  })
  .partial()
  .strict();
// Manual commands commit decimal Text through the same native field normalizer.
// Diagnostic preview retains its wider positive-frequency validation above.
const manualFilterPatch = filterPatch.extend({
  frequency: finite.optional(),
  frequency2: finite.optional(),
  q: finite.optional(),
  q2: finite.optional(),
  gain: finite.optional(),
});
const rawManualFilterPatch = manualFilterPatch.extend({
  coefficients: coefficients
    .partial()
    .refine((patch) => Object.keys(patch).length > 0, {
      message: 'Supply at least one coefficient',
    })
    .optional(),
});
const eqFilterPatch = z
  .object({
    kind: z.enum(['peak', 'lowshelf2', 'highshelf2']).optional(),
    enabled: z.boolean().optional(),
    frequency: finite.optional(),
    q: finite.optional(),
    gain: finite.optional(),
  })
  .strict();
const channelPatch = z
  .object({
    hardwareGain: z.boolean(),
    gainWheel: z
      .object({
        direction: z.enum(['up', 'down']),
        basis: z.enum(['each', 'left', 'right']).optional(),
      })
      .strict(),
    delayWheel: z
      .object({
        parameter: z.enum(['local', 'global']),
        direction: z.enum(['up', 'down']),
        basis: z.enum(['each', 'left', 'right']).optional(),
      })
      .strict(),
    includeInSum: z.boolean(),
    name: z.string(),
    outputName: z.string(),
    gain: z.union([finite, z.string()]),
    invert: z.boolean(),
    muted: z.boolean(),
    delayUs: z.union([finite, z.string()]),
    globalDelayUs: z.union([finite, z.string()]),
  })
  .partial()
  .strict()
  .refine((patch) => !Object.hasOwn(patch, 'hardwareGain') || Object.keys(patch).length === 1, {
    message: 'hardwareGain is a separate native callback intent; supply it alone',
  })
  .refine((patch) => !Object.hasOwn(patch, 'gainWheel') || Object.keys(patch).length === 1, {
    message: 'gainWheel is a separate native wheel intent; supply it alone',
  })
  .refine(
    (patch) =>
      !['delayUs', 'globalDelayUs', 'delayWheel'].some((key) => Object.hasOwn(patch, key)) ||
      Object.keys(patch).length === 1,
    {
      message: 'A delay callback is a separate intent; supply one delay value or delayWheel alone',
    },
  );
export const controlsSchema = z
  .object({
    mute: z.boolean(),
    volume: finite.min(-96).max(18),
    preset,
    channelMutes: z.array(z.boolean()).length(3),
    outputMute: z
      .object({ channel: z.number().int().min(1).max(3), muted: z.boolean() })
      .strict()
      .describe(
        'Mute or unmute one physical output (1–3), preserving other fresh mute bits. Supply this field alone.',
      ),
    routing: z.number().int().min(0).max(4),
    forceInput: z
      .number()
      .int()
      .min(0)
      .max(MAX_INPUT_SOURCE)
      .describe(
        `Native source ID: ${INPUT_SOURCES.map(({ id, label }) => `${id} ${label}`).join(', ')}. ${FUTURE_INPUT_NOTE}`,
      ),
    eqEnabled: z.boolean(),
    presetOffsets: z.array(finite.min(-24).max(24)).length(3),
    startupVolume: finite.min(-96).max(18).nullable(),
    powerOffMinutes: z.number().int().min(0).max(255),
    standbyMode: z.union([z.literal(0), z.literal(1)]),
    signalDetection: z.boolean(),
    bridge: z.boolean(),
    master: z
      .boolean()
      .describe(
        'False selects Slave and clears wake-on-mains, signal detection and fixed startup volume, with standby mode 0; other settings are retained.',
      ),
    wakeOnLine: z.boolean(),
    softClip: z.boolean(),
    subAbsolute: z.boolean(),
    analogGainXlr: z.boolean(),
    analogGainRca: z.boolean(),
    dacFilter: z.number().int().min(0).max(7),
    soundQuality: z.number().int().min(1).max(4),
    firMode: z.number().int().min(0).max(7),
    sourceLock: z.boolean(),
    volumeLock: z.boolean(),
    adcOutput: z.boolean(),
    detectionOn: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('Native ON selection 0–3; lowering ON also clamps OFF down when necessary.'),
    detectionOff: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('Native OFF selection 0–3; values above ON are clamped to ON.'),
    oledMaximumBrightness: z.number().int().min(0).max(15),
    oledDimmedBrightness: z.number().int().min(0).max(15),
    standbyLedMode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  })
  .partial()
  .strict()
  .refine((patch) => !Object.hasOwn(patch, 'outputMute') || Object.keys(patch).length === 1, {
    message: 'outputMute is a separate intent; supply it alone',
  });
const audioToolSchema = z
  .object({
    action: z.enum([
      'status',
      'devices',
      'configure',
      'enable',
      'start',
      'cancel',
      'disable',
      'apply',
      'discard',
      'choose-output',
    ]),
    config: publicCaptureConfig.optional(),
    requestId: captureRequestSchema.shape.requestId.optional(),
    target: z.object({ slot, preset, channel }).strict().optional(),
    expectedRevision: captureRequestSchema.shape.expectedRevision.optional(),
    name: captureRequestSchema.shape.name,
  })
  .strict()
  .superRefine((value, context) => {
    const required: Record<string, string[]> = {
      configure: ['config'],
      start: ['requestId', 'target', 'expectedRevision'],
      apply: ['requestId', 'expectedRevision'],
      discard: ['requestId'],
    };
    const allowed: Record<string, string[]> = {
      configure: ['config'],
      start: ['requestId', 'target', 'expectedRevision', 'name'],
      apply: ['requestId', 'expectedRevision'],
      discard: ['requestId'],
      cancel: ['requestId'],
    };
    for (const key of required[value.action] ?? [])
      if (value[key as keyof typeof value] === undefined)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for ${value.action}`,
        });
    for (const key of Object.keys(value))
      if (key !== 'action' && !(allowed[value.action] ?? []).includes(key))
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is not used by ${value.action}`,
        });
  });
const recoveryReference = {
  reviewId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const recoveryToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'clear', 'discard-code']) }).strict(),
  z
    .object({
      action: z.literal('review'),
      source: z.enum(['new-challenge', 'installed-challenge']),
      sourceConfirmed: z.literal(true).optional(),
    })
    .strict()
    .superRefine((p, context) => {
      if ((p.source === 'installed-challenge') !== (p.sourceConfirmed === true))
        context.addIssue({
          code: 'custom',
          path: ['sourceConfirmed'],
          message:
            'Confirm that the HFD challenge is already installed before using its support code',
        });
    }),
  z
    .object({
      action: z.literal('confirm-challenge'),
      ...recoveryReference,
      uniqueKey: z.string().regex(/^[a-f\d]{16}$/i),
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('review-code'),
      ...recoveryReference,
      code: z.string().min(1).max(4096),
      source: z.literal('hypex-support'),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit-code'),
      ...recoveryReference,
      codeReviewId: z.string().min(1).max(128),
      source: z.literal('hypex-support'),
      confirm: z.literal(true),
    })
    .strict(),
]);
const authToolSchema = z
  .object({
    action: z.enum([
      'status',
      'unlock',
      'password-change',
      'email-read',
      'email-set',
      'oem-propose',
      'oem-save',
      'oem-discard',
      'clear',
      'recovery',
    ]),
    refresh: z.boolean().optional(),
    credential: credentialInputSchema.optional(),
    current: credentialInputSchema.optional(),
    next: credentialInputSchema.optional(),
    confirm: credentialInputSchema.optional(),
    email: credentialInputSchema.optional(),
    mask: z.number().int().min(0).max(65535).optional(),
    proposalId: z.string().min(1).max(128).optional(),
    recovery: recoveryToolSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const required: Record<string, string[]> = {
      unlock: ['credential'],
      'password-change': ['next', 'confirm', 'email'],
      'email-set': ['email'],
      'oem-propose': ['mask'],
      'oem-save': ['proposalId'],
      recovery: ['recovery'],
    };
    const allowed: Record<string, string[]> = {
      status: ['refresh'],
      unlock: ['credential'],
      'password-change': ['current', 'next', 'confirm', 'email'],
      'email-set': ['email'],
      'oem-propose': ['mask'],
      'oem-save': ['proposalId'],
      recovery: ['recovery'],
    };
    for (const key of required[value.action] ?? [])
      if (value[key as keyof typeof value] === undefined)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for ${value.action}`,
        });
    for (const key of Object.keys(value))
      if (key !== 'action' && !(allowed[value.action] ?? []).includes(key))
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is not used by ${value.action}`,
        });
  });
const directoryCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      id: z.string().min(1).max(256).optional(),
      offset: z.number().int().min(0).max(100000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeArchived: z.boolean().optional(),
      fileOffset: z.number().int().min(0).max(100000).optional(),
      fileLimit: z.number().int().min(1).max(100).optional(),
    })
    .strict()
    .superRefine((p, context) => {
      if (
        p.id &&
        (p.offset !== undefined || p.limit !== undefined || p.includeArchived !== undefined)
      )
        context.addIssue({
          code: 'custom',
          message:
            'A record uses fileOffset/fileLimit; list pages use offset/limit/includeArchived',
        });
      if (!p.id && (p.fileOffset !== undefined || p.fileLimit !== undefined))
        context.addIssue({ code: 'custom', message: 'File paging requires an explicit record id' });
    }),
  z.object({ action: z.literal('retry-storage') }).strict(),
  z.object({ action: z.literal('forget-root'), rootId: z.string().min(1).max(256) }).strict(),
  z
    .object({
      action: z.literal('prepare'),
      slot,
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      requestId: z.string().min(1).max(256),
      mode: z.enum(['save', 'save-as']),
      rootId: z.string().min(1).max(256).optional(),
      folderName: z.string().min(1).max(255).optional(),
      exportId: z.string().min(1).max(256).optional(),
      metadata: z.enum(['auto', 'design']).optional(),
    })
    .strict()
    .superRefine((p, context) => {
      if (p.mode === 'save-as' && (!p.rootId || !p.folderName))
        context.addIssue({
          code: 'custom',
          message: 'Save As needs a granted root and folder name',
        });
      if (p.mode === 'save' && (p.rootId !== undefined || p.folderName !== undefined))
        context.addIssue({
          code: 'custom',
          message: 'Save uses the role’s saved folder association',
        });
    }),
  z
    .object({
      action: z.literal('commit'),
      id: z.string().min(1).max(256),
      allowOverwrite: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.enum(['retry', 'recover', 'discard-review', 'review-archive', 'review-legacy']),
      id: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      action: z.literal('export-recovery'),
      id: z.string().min(1).max(256),
      format: z.enum(['files', 'zip']).default('files'),
    })
    .strict(),
  z
    .object({
      action: z.literal('archive'),
      reviewId: z.string().min(1).max(256),
      confirm: z.literal(true),
      removeLocalRecovery: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('adopt-legacy'),
      reviewId: z.string().min(1).max(256),
      confirm: z.literal(true),
    })
    .strict(),
]);
const firmwareToolSchema = z
  .object({
    action: z.enum([
      'status',
      'inspect',
      'clear',
      'packets',
      'usb-status',
      'usb-choose',
      'usb-revalidate',
      'usb-clear',
      'runtime-status',
      'runtime-read',
      'runtime-clear',
      'update-status',
      'update-review',
      'update-apply',
      'update-discard',
      'update-review-recovery',
      'update-history',
      'update-export',
    ]),
    content: z.string().max(MAX_UI_TEXT_CHARACTERS).optional(),
    name: z.string().min(1).max(4096).optional(),
    pass: z.union([z.literal(0), z.literal(1)]).optional(),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(16384).optional(),
    stageIds: z
      .object({
        left: z.string().min(1).max(256).optional(),
        right: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    reviewId: z.string().min(1).max(256).optional(),
    recordId: z.string().min(1).max(256).optional(),
    confirm: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const required: Record<string, string[]> = {
      inspect: ['content', 'name'],
      packets: ['pass'],
      'update-review': ['stageIds'],
      'update-apply': ['reviewId', 'confirm'],
      'update-discard': ['reviewId'],
      'update-review-recovery': ['recordId'],
      'update-export': ['recordId'],
    };
    const allowed: Record<string, string[]> = {
      inspect: ['content', 'name'],
      packets: ['pass', 'offset', 'limit'],
      'update-review': ['stageIds'],
      'update-apply': ['reviewId', 'confirm'],
      'update-discard': ['reviewId'],
      'update-review-recovery': ['recordId'],
      'update-history': ['offset', 'limit'],
      'update-export': ['recordId', 'offset', 'limit'],
    };
    if (
      value.limit !== undefined &&
      ((value.action === 'packets' && value.limit > 50) ||
        (value.action === 'update-history' && value.limit > 16))
    )
      context.addIssue({
        code: 'custom',
        path: ['limit'],
        message: 'Limit exceeds this action’s page size',
      });
    for (const key of required[value.action] ?? [])
      if (value[key as keyof typeof value] === undefined)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for ${value.action}`,
        });
    for (const key of Object.keys(value))
      if (key !== 'action' && !(allowed[value.action] ?? []).includes(key))
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is not used by ${value.action}`,
        });
  });
async function preflightTargets(
  slots: Slot[],
  check: (slot: Slot) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    slots.map(async (slot) => {
      await check(slot);
    }),
  );
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${slots[index]}: ${String(result.reason)}`] : [],
  );
  if (failures.length) throw new Error(failures.join(' · '));
}
const schemas = {
  fusion_audio: audioToolSchema,
  fusion_state: z.object({ includeProjects: z.boolean().default(false) }).strict(),
  fusion_select: z
    .object({
      slot: slot.optional(),
      preset: preset.optional(),
      channel: channel.optional(),
      filter: index.optional(),
      linkedEdits: z.boolean().optional(),
      linkedControls: z.boolean().optional(),
    })
    .strict(),
  fusion_project_new: z.object({ target, name: z.string().max(200) }).strict(),
  fusion_rename: z
    .object({ target, name: z.string(), preset: preset.optional() })
    .strict()
    .superRefine((value, context) => {
      if (value.preset === undefined && value.name.length > 200)
        context.addIssue({
          code: 'custom',
          message: 'Project name exceeds 200 characters',
          path: ['name'],
        });
    }),
  fusion_project_import: z
    .object({
      target,
      name: z.string().max(200).default('Imported project'),
      content: z.string().max(80e6),
    })
    .strict(),
  fusion_project_import_folder: z
    .object({
      target,
      name: z.string(),
      files: z
        .array(z.object({ path: z.string(), content: z.string().max(80e6) }).strict())
        .min(1)
        .max(2000),
    })
    .strict(),
  fusion_project_files: z.object({ slot }).strict(),
  fusion_project_save: z.discriminatedUnion('action', [
    z.object({ action: z.literal('status') }).strict(),
    z
      .object({
        action: z.literal('stage'),
        target,
        expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        mode: z.enum(['auto', 'design']).default('auto'),
      })
      .strict(),
    z.object({ action: z.enum(['resolve', 'release']), id: z.string().min(1).max(256) }).strict(),
  ]),
  fusion_library_list: z.object({ includeRemoved: z.boolean().default(false) }).strict(),
  fusion_library_save: z.object({ slot }).strict(),
  fusion_library_open: z.object({ target, id: z.string() }).strict(),
  fusion_library_remove: z.object({ id: z.string(), removed: z.boolean() }).strict(),
  fusion_project_export: z
    .object({ slot, format: z.enum(['json', 'hfd-xml']).default('json') })
    .strict(),
  fusion_filter_palette: z
    .object({
      action: z.enum(['open', 'update', 'apply', 'cancel']),
      mode: z.enum(['add', 'replace']).optional(),
      index: index.optional(),
      draft: manualFilterPatch.optional(),
    })
    .strict(),
  fusion_preview_filter: z
    .object({
      filter: filterPatch.extend({ kind: kinds }),
      frequencies: z
        .array(finite.min(0.001).max(FS / 2))
        .min(1)
        .max(4096),
    })
    .strict(),
  fusion_filter_add: z
    .object({
      target,
      preset,
      channel,
      frequency: finite,
      kind: kinds.default('peak'),
    })
    .strict(),
  fusion_filter_set: z
    .object({
      target,
      preset,
      channel,
      index,
      patch: rawManualFilterPatch,
      redesign: z.boolean().default(true),
    })
    .strict(),
  fusion_filter_adjust: z.union([
    z
      .object({
        target,
        preset,
        channel,
        index,
        surface: z.literal('graph-drag'),
        frequency: z.number().finite().min(0.001).max(50000),
        originAxisY: z.number().finite(),
        axisY: z.number().finite(),
      })
      .strict(),
    z
      .object({
        target,
        preset,
        channel,
        index,
        parameter: z.enum(['q', 'q2', 'gain']),
        direction: z.enum(['up', 'down']),
        basis: z.enum(['each', 'left', 'right']).default('each'),
        surface: z.enum(['field', 'graph']).default('field'),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.surface === 'graph' && value.parameter !== 'q')
          context.addIssue({
            code: 'custom',
            message: 'Graph surface supports primary Q only',
            path: ['parameter'],
          });
        if (value.target !== 'both' && value.basis !== 'each' && value.basis !== value.target)
          context.addIssue({
            code: 'custom',
            message: 'Wheel source must be a selected role',
            path: ['basis'],
          });
      }),
  ]),
  fusion_biquad_exchange: z
    .object({ target, preset, channel, first: index, second: index })
    .strict(),
  fusion_channel_copy: z.object({ target, preset, source: channel, destination: channel }).strict(),
  fusion_preset_clear: z.object({ target, preset }).strict(),
  fusion_filter_move: z.object({ target, preset, channel, from: index, to: index }).strict(),
  fusion_filter_reset: z.object({ target, preset, channel, index }).strict(),
  fusion_filter_delete: z.object({ target, preset, channel, index }).strict(),
  fusion_channel_cache: z
    .object({ target, preset, channel, interpretation: z.enum(['base', 'effective']) })
    .strict(),
  fusion_channel_link: z.object({ target, preset, channel, to: channel.nullable() }).strict(),
  fusion_channel_set: z.object({ target, preset, channel, patch: channelPatch }).strict(),
  fusion_copy: z
    .object({
      from: slot,
      to: slot,
      preset,
      channel: channel.optional(),
      destinationPreset: preset.optional(),
    })
    .strict(),
  fusion_history: z.object({ action: z.enum(['undo', 'redo']) }).strict(),
  fusion_eq_default: z.object({ target, preset }).strict(),
  fusion_eq_copy_all: z.object({ target, preset }).strict(),
  fusion_eq_save_all: z.object({ target, preset }).strict(),
  fusion_eq_bank: z
    .object({
      action: z.enum([
        'inspect',
        'copy-design',
        'copy-device',
        'apply-design',
        'write-device',
        'clear',
      ]),
      source: slot.optional(),
      target: target.optional(),
    })
    .strict(),
  fusion_workspace_storage: z
    .object({
      action: z.enum([
        'status',
        'retry',
        'flush',
        'recovery-export',
        'file-transfer',
        'project-sources',
        'project-directory',
      ]),
      command: z.enum(FILE_TOOL_NAMES).optional(),
      arguments: z.record(z.string(), z.json()).optional(),
      sources: sourceCommand.optional(),
      directory: directoryCommand.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.action === 'file-transfer' && !value.command)
        context.addIssue({
          code: 'custom',
          message: 'File transfer requires a command',
          path: ['command'],
        });
      if (
        value.action !== 'file-transfer' &&
        (value.command !== undefined || value.arguments !== undefined)
      )
        context.addIssue({
          code: 'custom',
          message: 'File arguments require the file-transfer action',
        });
      if ((value.action === 'project-sources') !== (value.sources !== undefined))
        context.addIssue({
          code: 'custom',
          message: 'Project sources require action project-sources and a sources command',
        });
      if ((value.action === 'project-directory') !== (value.directory !== undefined))
        context.addIssue({
          code: 'custom',
          message: 'Project folder writes require action project-directory and a directory command',
        });
    }),
  fusion_project_sources: sourceCommand,
  fusion_project_directory: directoryCommand,
  fusion_file_upload_begin: z
    .object({
      operation: ImportWorkflowSchema,
      files: z
        .array(
          z
            .object({
              path: z.string(),
              bytes: z.number().int().min(0).max(FILE_TRANSFER_MAX_FILE_BYTES),
              sha256,
            })
            .strict(),
        )
        .min(1)
        .max(2000),
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
  fusion_file_upload_chunk: z
    .object({
      id: fileHandle,
      fileIndex,
      chunkIndex,
      base64: z.string().max(Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4),
      sha256,
    })
    .strict(),
  fusion_file_upload_commit: z.object({ id: fileHandle }).strict(),
  fusion_file_export: z.object({ operation: ExportWorkflowSchema }).strict(),
  fusion_file_chunk_read: z.object({ id: fileHandle, fileIndex, chunkIndex }).strict(),
  fusion_file_status: z
    .object({
      id: fileHandle,
      fileOffset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(100),
      rebind: z.boolean().default(false),
    })
    .strict(),
  fusion_file_list: z
    .object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(100),
      includeOtherScopes: z.boolean().default(false),
    })
    .strict(),
  fusion_file_close: z.object({ id: fileHandle }).strict(),
  fusion_eq_set: z
    .object({
      target,
      preset,
      index: z.number().int().min(1).max(9),
      patch: eqFilterPatch,
      enabled: z.boolean().optional(),
      redesign: z.boolean().default(false),
    })
    .strict(),
  fusion_eq_adjust: z
    .object({
      target,
      preset,
      index: z.number().int().min(1).max(9),
      parameter: z.enum(['frequency', 'q', 'gain']),
      direction: z.enum(['up', 'down']),
      basis: z.enum(['each', 'left', 'right']).default('each'),
    })
    .strict(),
  fusion_fir_set: z
    .object({
      target,
      preset,
      channel: z.number().int().min(0).max(3).optional(),
      name: z.string().optional(),
      text: z.string().max(5e6).optional(),
      clear: z.boolean().optional(),
      enabled: z.boolean().optional(),
      native: nativeFirAction.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.native) {
        if (
          ['channel', 'name', 'text', 'clear', 'enabled'].some((key) => Object.hasOwn(value, key))
        )
          context.addIssue({
            code: 'custom',
            message:
              'Native FIR actions cannot be combined with file-load or browser enable/unload fields',
          });
      } else if (value.channel === undefined || value.name === undefined)
        context.addIssue({
          code: 'custom',
          message: 'A file-load or browser FIR action requires channel and name',
        });
    }),
  fusion_measurement_set: z
    .object({
      target,
      preset,
      channel,
      name: z.string(),
      text: z.string().max(20e6).nullable(),
      sampleRate: finite.min(8000).max(384000).default(48000),
      format: z.enum(['auto', 'impulse', 'frequency']).default('auto'),
      analysis: z.enum(['browser', 'hfd']).optional(),
    })
    .strict(),
  fusion_analyze: z
    .object({
      slot,
      preset,
      frequencies: z
        .array(finite.min(0.001).max(FS / 2))
        .min(1)
        .max(4096),
      measured: z.boolean().default(false),
      nativeCentered: z.boolean().default(true),
      showUnloadedFilters: z.boolean().default(false),
      referenceChannel: channel.default(1),
      layers: z
        .object({
          rawMeasurements: z.array(z.boolean()).length(3),
          currentResult: z.boolean(),
          otherResults: z.boolean().optional(),
          section: z.boolean(),
          selectedFilter: index.nullable().optional(),
          sum: z.boolean().default(true),
        })
        .strict()
        .optional(),
    })
    .strict(),
  fusion_compile: z.object({ slot, preset }).strict(),
  fusion_hfd_measurement: z
    .object({
      target,
      preset,
      channel: channel.default(1),
      action: z.enum([
        'inspect',
        'enable',
        'browser',
        'options',
        'enable-preset',
        'share',
        'audio',
      ]),
      audio: audioToolSchema.optional(),
      sourceChannel: channel.nullable().optional(),
      patch: z
        .object({
          sampleRate: finite.min(1000).max(100000).optional(),
          localStart: z.number().int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX).optional(),
          stopInclusive: z.number().int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX).optional(),
          phaseStart: z.number().int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX).optional(),
          smoothBw: finite.min(0).max(3).optional(),
          smoothPostBw: finite.min(0).max(10).optional(),
          applyMicCorrection: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.action === 'audio') {
        if (!value.audio)
          context.addIssue({ code: 'custom', path: ['audio'], message: 'Supply an audio command' });
        if (value.patch !== undefined || value.sourceChannel !== undefined)
          context.addIssue({
            code: 'custom',
            message: 'Audio commands do not use HFD measurement options or shared-crop fields',
          });
      } else {
        if (value.audio !== undefined)
          context.addIssue({
            code: 'custom',
            path: ['audio'],
            message: 'audio is only valid with action audio',
          });
      }
    }),
  fusion_microphone: z
    .object({
      target,
      action: z.enum(['inspect', 'load', 'unload', 'options']),
      content: z.string().max(20e6).optional(),
      name: z.string().optional(),
      showCurve: z.boolean().optional(),
      smoothingOctaves: finite.min(0).max(3).optional(),
    })
    .strict(),
  fusion_time_analyze: z
    .object({
      slot,
      preset,
      referenceChannel: channel.default(1),
      scope: z.enum(['crossover', 'input-eq']).default('crossover'),
      mode: z.enum(['Impulse', 'Step']).default('Impulse'),
      measured: z.boolean().default(false),
      sum: z.boolean().default(true),
      timeMinMs: finite.min(-600000).max(600000).optional(),
      timeMaxMs: finite.min(-600000).max(600000).optional(),
      points: z.number().int().min(1).max(4096).default(1024),
    })
    .strict()
    .refine(
      (p) => p.timeMinMs === undefined || p.timeMaxMs === undefined || p.timeMinMs < p.timeMaxMs,
      'Time minimum must be below maximum',
    ),
  fusion_help: z
    .object({
      action: z.enum(['resources', 'show']).default('resources'),
      view: z.enum(['help', 'verification']).optional(),
    })
    .strict()
    .refine((p) => p.action === 'show' || p.view === undefined, {
      path: ['view'],
      message: 'Choose a view only when showing Help or Verification',
    }),
  fusion_view: z
    .object({
      projectSavePanel: z.boolean().optional(),
      noisePanel: z.boolean().optional(),
      graph: graphViewPatch.optional(),
      healthDetails: z.boolean().optional(),
      meters: z.boolean().optional(),
      authPanel: z.enum(['closed', 'password', 'permissions']).optional(),
      expertBank: z.boolean().optional(),
      designer: z.enum(['graph', 'chain']).optional(),
      selectedBiquads: z.array(index).max(15).optional(),
      copySourceChannel: channel.nullable().optional(),
      tab: z
        .enum([
          'Crossover',
          'Input EQ',
          'FIR',
          'Measurements',
          'Device settings',
          'Backups',
          'Help',
          'Verification',
          'Agent access',
        ])
        .optional(),
      mode: z.enum(['Magnitude', 'Phase', 'Group delay', 'Impulse', 'Step']).optional(),
      sum: z.boolean().optional(),
      measured: z.boolean().optional(),
      measurementView: z.enum(['frequency', 'phase', 'impulse']).optional(),
      calibrationCurve: z.boolean().optional(),
      nativeCentered: z.boolean().optional(),
      showUnloadedFilters: z.boolean().optional(),
      eqBand: z.number().int().min(1).max(9).optional(),
      coefficients: z.boolean().optional(),
      resetPlot: z.boolean().optional(),
      zoomBack: z.boolean().optional(),
      zoomRectangle: z.boolean().optional(),
      frequencyMin: finite.min(0.001).max(50000).optional(),
      frequencyMax: finite.min(0.001).max(50000).optional(),
      dbMin: finite.min(-300).max(200).optional(),
      dbMax: finite.min(-300).max(200).optional(),
      timeMinMs: finite.min(-600000).max(600000).optional(),
      timeMaxMs: finite.min(-600000).max(600000).optional(),
      amplitudeMin: finite.min(-1e12).max(1e12).optional(),
      amplitudeMax: finite.min(-1e12).max(1e12).optional(),
      fitTime: z.enum(['response', 'truncated']).optional(),
    })
    .strict()
    .superRefine((p, context) => {
      if (
        p.zoomBack &&
        (p.zoomRectangle ||
          p.resetPlot ||
          p.fitTime ||
          [
            'frequencyMin',
            'frequencyMax',
            'dbMin',
            'dbMax',
            'timeMinMs',
            'timeMaxMs',
            'amplitudeMin',
            'amplitudeMax',
          ].some((key) => p[key as keyof typeof p] !== undefined))
      )
        context.addIssue({
          code: 'custom',
          path: ['zoomBack'],
          message: 'Zoom back cannot be combined with a new plot range',
        });
      if (p.zoomRectangle && (p.resetPlot || p.fitTime))
        context.addIssue({
          code: 'custom',
          path: ['zoomRectangle'],
          message: 'Rectangle zoom cannot be combined with Fit or Reset',
        });
      for (const [min, max] of [
        ['frequencyMin', 'frequencyMax'],
        ['dbMin', 'dbMax'],
        ['timeMinMs', 'timeMaxMs'],
        ['amplitudeMin', 'amplitudeMax'],
      ] as const)
        if (p[min] !== undefined && p[max] !== undefined && p[min]! >= p[max]!)
          context.addIssue({
            code: 'custom',
            message: 'Graph minimum must be below maximum',
            path: [max],
          });
    }),
  fusion_connect: z.object({ slot, serial: z.string().optional() }).strict(),
  fusion_devices: z.discriminatedUnion('action', [
    z.object({ action: z.literal('status') }).strict(),
    z.object({ action: z.literal('discover') }).strict(),
    z
      .object({
        action: z.literal('assign'),
        id: z.string().min(1).max(200),
        slot,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({ action: z.literal('swap'), expectedRevision: z.number().int().nonnegative() })
      .strict(),
    z
      .object({
        action: z.literal('disconnect'),
        slot,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        action: z.literal('auto-connect'),
        enabled: z.boolean(),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    z.object({ action: z.literal('read'), slot }).strict(),
  ]),
  fusion_disconnect: z.object({ target }).strict(),
  fusion_controls: z
    .object({ target, patch: controlsSchema, relativeVolume: z.boolean().default(false) })
    .strict(),
  fusion_read_preset: z.object({ slot, preset }).strict(),
  fusion_backup: z.object({ target, preset }).strict(),
  fusion_backups_list: z.object({ serial: z.string().optional() }).strict(),
  fusion_backup_import: z.object({ content: z.string().max(1e6) }).strict(),
  fusion_restore: z.object({ slot, backupId: z.string() }).strict(),
  fusion_upload: z.object({ target, preset }).strict(),
  fusion_upload_all: z.object({ target }).strict(),
  fusion_eq_read: z.object({ slot, preset }).strict(),
  fusion_eq_upload: z.object({ target, preset }).strict(),
  fusion_fir_read: z.object({ slot, preset }).strict(),
  fusion_fir_upload: z.object({ target, preset }).strict(),
  fusion_fir_backups: z.object({ serial: z.string().optional() }).strict(),
  fusion_fir_restore: z.object({ slot, backupId: z.string() }).strict(),
  fusion_fir_placement: z
    .object({ target, preset, placement: z.enum(['input', 'output']) })
    .strict(),
  fusion_measurement_import_wav: z
    .object({
      target,
      preset,
      channel,
      name: z.string(),
      base64: z.string().max(20e6),
      analysis: z.enum(['browser', 'hfd']).optional(),
    })
    .strict(),
  fusion_measurement_window: z
    .object({
      target,
      preset,
      channel,
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      taper: finite.min(0).max(1),
      timeZero: finite,
    })
    .strict(),
  fusion_measurement_smooth: z
    .object({ target, preset, channel, octaves: finite.min(0).max(3) })
    .strict(),
  fusion_measurement_calibrate: z
    .object({ target, preset, channel, content: z.string().max(5e6), name: z.string() })
    .strict(),
  fusion_measurement_processing: z
    .object({
      target,
      preset,
      channel,
      audio: audioToolSchema.optional(),
      truncateToView: z.literal(true).optional(),
      reset: z.boolean().optional(),
      resetWindow: z.boolean().optional(),
      sampleRate: finite.min(8000).max(384000).optional(),
      peakZero: z.boolean().optional(),
      calibrationEnabled: z.boolean().optional(),
      clearCalibration: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.audio !== undefined)
        for (const key of [
          'reset',
          'resetWindow',
          'sampleRate',
          'peakZero',
          'calibrationEnabled',
          'clearCalibration',
          'truncateToView',
        ] as const)
          if (value[key] !== undefined)
            context.addIssue({
              code: 'custom',
              path: [key],
              message: 'Audio commands cannot be combined with measurement-processing changes',
            });
      if (value.truncateToView)
        for (const key of [
          'audio',
          'reset',
          'resetWindow',
          'sampleRate',
          'peakZero',
          'calibrationEnabled',
          'clearCalibration',
        ] as const)
          if (value[key] !== undefined)
            context.addIssue({
              code: 'custom',
              path: [key],
              message: 'Native Truncate cannot be combined with other processing changes',
            });
    }),
  fusion_measurement_export: z
    .object({ slot, preset, channel, format: z.enum(['impulse', 'frequency']) })
    .strict(),
  fusion_device_read: z
    .object({
      target,
      firmware: firmwareToolSchema.optional(),
      auth: authToolSchema.optional(),
      noise: noiseAction.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ([value.auth, value.firmware, value.noise].filter(Boolean).length > 1)
        context.addIssue({
          code: 'custom',
          path: ['auth'],
          message: 'Choose authentication, firmware or noise actions separately',
        });
      if (
        value.target === 'both' &&
        value.auth &&
        !['status', 'clear'].includes(value.auth.action) &&
        !(
          value.auth.action === 'recovery' &&
          ['status', 'clear'].includes(value.auth.recovery?.action ?? '')
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'Choose one amplifier role for a credential or OEM operation',
        });
      if (
        value.target === 'both' &&
        ['packets', 'usb-choose'].includes(value.firmware?.action ?? '')
      )
        context.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'Choose one role for a firmware packet page or USB descriptor chooser',
        });
    }),
  fusion_noise: z.object({ target, command: noiseAction }).strict(),
  fusion_power: z.object({ target, state: z.enum(['off', 'on']) }).strict(),
  fusion_device_defaults: z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('status'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    z.object({ action: z.literal('refresh-history') }).strict(),
    z.object({ action: z.literal('review'), target: z.enum(['left', 'right', 'both']) }).strict(),
    z
      .object({ action: z.literal('apply'), reviewId: z.string().uuid(), confirm: z.literal(true) })
      .strict(),
    z.object({ action: z.literal('discard-review'), reviewId: z.string().uuid() }).strict(),
    z.object({ action: z.literal('review-recovery'), id: z.string().uuid() }).strict(),
    z
      .object({
        action: z.literal('restore'),
        reviewId: z.string().uuid(),
        confirm: z.literal(true),
      })
      .strict(),
    z.object({ action: z.literal('export-record'), id: z.string().uuid() }).strict(),
  ]),
  fusion_device_clone: deviceCloneToolSchema,
  fusion_amplifier_modes: amplifierModesToolSchema,
  fusion_native_mixer: nativeMixerToolSchema,
  fusion_limiter_editor: z.discriminatedUnion('action', [
    z.object({ action: z.literal('status') }).strict(),
    z.object({ action: z.literal('load'), target }).strict(),
    z
      .object({
        action: z.literal('edit'),
        target,
        expectedRevision: z.number().int().nonnegative(),
        edit: z.union([
          z.object({ type: z.literal('power'), channel, value: finite.min(0).max(1000) }).strict(),
          z
            .object({ type: z.literal('impedance'), channel, value: finite.min(1).max(25) })
            .strict(),
          z.object({ type: z.literal('attack-time'), value: finite.min(0.3).max(999.9) }).strict(),
          z.object({ type: z.literal('release-time'), value: finite.min(5).max(99.9) }).strict(),
          z
            .object({
              type: z.literal('expert-text'),
              channel: z.number().int().min(1).max(3),
              field: z.enum(['threshold', 'attack', 'release']),
              text: z.string().max(128),
            })
            .strict(),
          z
            .object({
              type: z.literal('expert-exit'),
              channel: z.number().int().min(1).max(3),
              field: z.enum(['threshold', 'attack', 'release']),
            })
            .strict(),
          z.object({ type: z.literal('expert-mode'), value: z.boolean() }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        action: z.literal('review'),
        target,
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({ action: z.literal('apply'), reviewId: z.string().uuid(), confirm: z.literal(true) })
      .strict(),
    z.object({ action: z.literal('discard-review'), reviewId: z.string().uuid() }).strict(),
  ]),
  fusion_limiter_set: z
    .object({
      target,
      channels: z
        .array(
          z
            .object({
              watts: finite.min(5).max(1275),
              ohms: finite.min(0.1).max(25.5),
              attackMs: finite.positive(),
              releaseMs: finite.min(5.0001),
            })
            .strict(),
        )
        .length(3),
    })
    .strict(),
  fusion_configuration_backup: z.object({ target }).strict(),
  fusion_configuration_backups: z.object({ serial: z.string().optional() }).strict(),
  fusion_configuration_restore: z.object({ slot, backupId: z.string() }).strict(),
};
export type ToolName = keyof typeof schemas;
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  fusion_devices:
    'Discover and manage previously permitted USB amplifiers through the same human connection manager. status is cached. discover reads identities and routing hints without opening a permission chooser or changing amplifier settings. Confirmed serial-to-Left/Right assignments are remembered in this browser; exclusive digital routing can suggest a side but does not prove physical speaker location. assign, swap and disconnect require the current discovery expectedRevision. They change connection bindings only, preserve both local designs and never write routing, bridge, mute, volume, power or filters. auto-connect changes the local reconnect preference only. read explicitly loads all three crossover presets, physical input EQ, selected FIR banks and device settings into one role local design, saving exact recovery images and retaining a single Undo step. Compiled raw filter coefficients are preserved; original filter types/frequency/Q are not claimed recovered. A new device needs the human Add amplifier permission gesture once. Ambiguous hints and duplicate identities never take a role by enumeration order.',
  fusion_native_mixer:
    'Use the shared native digital User mixer editor for eligible OEM StereoDSP devices. No manufacturing enable operation is exposed. status reads cached weights, eligibility, independent Left/Right drafts, reviews and bounded history without I/O. load freshly reads the complete three-preset matrix and opens only the explicit one-based preset; open applies native modal formatting to that row without I/O. edit stages one CH1/2/3 left/right contribution in -1..1 at an exact revision; negative weights invert and no sum normalization is imposed. cancel restores the exact captured row and closes it. review captures fresh identities, permissions and matrix baselines. save requires a context-bound one-use reviewId and confirm:true; all changed-target before-images are durably verified before any setter, followed by an all-target fresh barrier. Only the selected row changes; other physical presets remain byte-exact. Both uses each amplifier own draft. One 67/01 attempt per changed target is independently read back; partial and uncertain outcomes stay in the UI and never retry or roll back automatically. refresh-history reads local journals; export-record returns a checked chunked recovery record. No common settings, DSP power, bridge or manufacturing configuration writes. Physical OEM mixer and two-device operation remain unqualified.',
  fusion_amplifier_modes:
    'Use the same staged amplifier configuration editor as the human UI. status reads cached mode drafts, permissions, coupled setting previews and the latest result without device I/O. edit changes master/slave, bridge or soft clip drafts at an exact revision; it sends no reports. Left and Right retain independent drafts; Both applies each own draft and skips unchanged roles. cancel discards the selected drafts. load explicitly reads fresh selected devices and resets those drafts. review reads fresh identities/permissions and fences the mode-owned fields, including native master/slave dependencies; apply requires its one-use reviewId and confirm:true. All selected targets are preflighted and all changed-target configuration backups verified before any setter. Fresh unrelated runtime, mute, sources, EQ/FIR, display and security settings are preserved. No automatic mute, DSP restart, retry or rollback. A partial result marks each fixed amplifier separately and appears in the UI. Consumed receipt replay performs no I/O. Bridge configuration must never be applied during live testing with the connected Right drivers.',
  fusion_device_clone:
    'Capture and clone native FA503 device settings, limiter, hardware, display, physical input-EQ banks and the current three-preset crossover/FIR design through the shared UI controller. Explicit Left/Right/Both targets retain independent templates and identities. status is cached; refresh-history reads local recovery records. reload atomically captures validated connected-device metadata into the selected design roles, preserving staged filters and editable EQ. overrides configures master/slave and three preset source/lock overrides at an exact controller revision. review is read-only and returns exact before/after settings; apply requires its context-bound one-use reviewId and confirm:true. All targets are backed up before the first write; outputs stay muted. Partial/uncertain outcomes never replay or roll back automatically. export-record creates a checked chunked file transfer containing complete recovery images. Protected Clone, physical two-device operation and native short FIR transfer behavior remain unqualified; no firmware or credential cloning.',
  fusion_audio:
    'Configure/enable browser measurement audio, inspect devices/state, start or cancel a Take, or apply/discard a retained result. Preset, channel, inputChannel and outputChannel are one-based in arguments and returned metadata. Start emits an audible sweep and clears the previous measurement first; Undo restores it. Requires trusted context, explicit slot/preset/channel and design revision. RequestId retries never replay an acknowledged Take within the one-hour durable receipt window. Start acknowledges immediately; poll status. Browser routing/clock/latency are not ASIO-equivalence claims. No amplifier USB writes.',
  fusion_file_upload_begin:
    'Begin a checked large-file import into explicit design destinations. Supply byte lengths/SHA-256 and an offline import operation. Captures the design revision and authenticated execution scope; returns a paged manifest. No amplifier writes.',
  fusion_file_upload_chunk:
    'Upload a zero-based file/chunk index as base64 (up to256 KiB decoded) with its SHA-256. Matching retries are idempotent. Out-of-order chunks are supported; conflicting duplicates fail.',
  fusion_file_upload_commit:
    'Verify complete file hashes and import once using the captured destination/revision. The durable receipt and design are saved together before success. Retry returns the same receipt; ambiguous outcomes are never blindly reapplied. No amplifier writes.',
  fusion_file_export:
    'Snapshot a project, native folder, response, FIR, saved recovery file or workspace into immutable downloadable chunks. Large data stays in browser storage; returns a paged manifest. No amplifier reads/writes.',
  fusion_file_chunk_read:
    'Read a zero-based export file/chunk as base64 with byte length and SHA-256. Reads are repeatable until close or expiry. Verify full file size/hash against the manifest.',
  fusion_file_status:
    'Read a paged transfer manifest and missing chunk indexes. Explicit rebind resumes a transfer under a new authenticated scope for the same owner; it cannot claim another owner’s transfer.',
  fusion_file_list:
    'Find this owner’s staged transfers, including handles from a lost response. Default lists the current execution scope; explicitly includeOtherScopes to discover your older scopes for rebind. Returns bounded summaries, never file content.',
  fusion_file_close:
    'Close/abort temporary staged file data after use. This does not undo an import. An in-flight commit can finish; inspect its outcome if marked unknown.',
  fusion_project_import_folder:
    'Import an HFD Config.xml and its associated impulse DAT files from relative paths and text contents. A native HFD open reconciles differing Global delays by copying the first raw value and maximum in the original saved preset, then in the chosen preset after the dialog Graph effects. Equal Global values retain differing maxima. A consumed browser JSON sidecar remains passive. All selected roles are prepared before one replacement.',
  fusion_project_files:
    'Return Config.xml, impulse DAT files and the lossless browser project for saving as an HFD project folder.',
  fusion_project_save:
    'Prepare the same frozen project Save artifact used by the human Save dialog. stage binds explicit Left, Right or Both roles, design revision, device sessions and identities without I/O. mode:auto includes fresh settings and three physical EQ banks for initially connected roles; mode:design is an explicit design-only choice. resolve performs matched double reads and publishes all selected roles together, with no amplifier setters or workspace edits. Failed or replaced targets never silently fall back to old metadata. status is cached; release cancels late publication. Successful resolve reuses immutable captured bytes without another device read. Pass exportId to folder Prepare, or export through fusion_file_export workflow native-project-save with this id, explicit slot and format json/hfd-xml/folder/zip. Keep the page open; artifacts are bounded and page-local, while prepared folder journals retain their own exact recovery bytes.',
  fusion_library_list: 'List locally saved project snapshots and optional removed snapshots.',
  fusion_library_save:
    'Save a complete project snapshot, including measurements, in the local browser library.',
  fusion_library_open: 'Open a saved project snapshot in one or both editing roles.',
  fusion_library_remove: 'Remove or recover a saved snapshot using the library’s reversible trash.',
  fusion_filter_palette:
    'Open, edit, apply or cancel a visual filter preview. No amplifier writes; target roles and channel are captured when opened.',
  fusion_preview_filter:
    'Calculate a proposed filter’s coefficients and complex response without changing a project or device.',
  fusion_filter_add:
    'Add a new filter to the first unused Unity slot, with Boost/Cut as the default. Explicit frequency commits use native decimal Text, 10–50,000 Hz bounds, one decimal and Single storage.',
  fusion_channel_cache:
    'Resolve an ambiguous custom first-section XML cache as base coefficients or coefficients already including channel gain.',
  fusion_channel_link:
    'Link a channel to a master within its preset, copying its processing while retaining measurements and labels, or unlink it.',
  fusion_eq_read: 'Read nine-band input EQ into a document, saving its original sector.',
  fusion_eq_upload:
    'Back up and upload input EQ to the selected amplifiers, reload it and verify while retaining mute.',
  fusion_fir_read:
    'Back up and read the physical input or output FIR with its name and activation state.',
  fusion_fir_upload:
    'Back up shared FIR sectors and names, mute every selected amplifier, program and verify the selected FIR placement, then activate while retaining mute. Effective graph FIRs in the opposite placement are retained in the design but are not transferred; per-role warnings are returned. Full selected tap caches and existing device preflight remain required.',
  fusion_fir_backups: 'List complete local FIR recovery manifests without returning flash data.',
  fusion_fir_restore:
    'Restore all FIR sectors, filenames and activation flags from an identity-bound recovery manifest.',
  fusion_fir_placement:
    'Select input or per-output FIR placement using native Used flags while retaining each resource’s latent Enabled state. Design edit only.',
  fusion_measurement_import_wav:
    'Import a base64-encoded PCM or floating-point WAV impulse response.',
  fusion_measurement_window:
    'Set original-sample window controls. Browser mode applies taper and time-zero rotation; native mode requires taper zero and maps to an inclusive crop plus independent phase start.',
  fusion_measurement_smooth:
    'Set browser fractional-octave power smoothing, or native post-plot Gaussian width. Native zero selects None (0.0001); the pre-interpolation width is retained.',
  fusion_measurement_calibrate:
    'Load correction for the selected measurement. Native mode loads the project-wide microphone file and enables only the selected channel apply flag; browser mode keeps a separate per-measurement curve.',
  fusion_upload_all:
    'Back up all three crossover presets on one or both amplifiers before programming any, retain mute, verify per-preset IIR/FIR and restore each starting active preset. Each preset transfers only its selected FIR placement; effective opposite-placement graph FIRs stay in the document, are not transferred, and produce per-role/preset warnings in fir metadata. Input EQ is separate.',
  fusion_measurement_processing:
    'Reset/bypass measurement processing, correction or phase zero, or change sample rate. truncateToView:true applies the currently visible measured Crossover Impulse/Step time bounds to explicit native destinations; original samples/phase are retained, no hidden range arguments or other patches may be combined. Cached clients may supply audio with exact fusion_audio arguments; legacy selectors are then ignored. Audio uses trusted context and one-based numbering.',
  fusion_measurement_export: 'Return impulse samples or frequency/dB/phase text for saving.',
  fusion_state: 'Read workspace selection, amplifier connections and capabilities.',
  fusion_select:
    'Select the editing role, preset, channel or filter and set linking preferences. Explicit navigation to a visible Crossover output graph shares the human graph-entry operation: its first entry can normalize that channel’s stored compensation/Gain and clear explicitly unloaded microphone application, with one combined Undo. Qualified explicit graph entry also repeats the immediate-source processing copy for a linked channel, including revisits; filter-only selection and graph-option changes do not trigger that copy. Explicit channel navigation also records the native selected group. Mirror does not initialize the opposite role; hidden editor selections, status reads, hydration and Undo do not run initialization. No amplifier I/O.',
  fusion_project_new: 'Create a new FA503 design in the chosen roles.',
  fusion_rename:
    'Rename the existing project (up to 200 characters), or one preset when preset is supplied, without changing processing or selection. Paired changes use one Undo.',
  fusion_project_import:
    'Import a local HFD XML or Fusion JSON design without applying saved device settings. Native HFD Open reconciles differing Global delays using the first raw value and maximum in the original saved preset, then the chosen preset after dialog Graph effects; equal values retain differing maxima. JSON snapshots remain passive. Every selected role is prepared before one replacement.',
  fusion_project_export: 'Return a project file as text for saving.',
  fusion_filter_set:
    'Edit a manual crossover biquad. Explicit frequency/F2 commits use canonical decimal Text, 10–50,000 Hz bounds, one decimal and Single storage. Ordinary FA Q/Q2 commits use 0.1–20, three decimals and Double storage; BQ gain uses −125…24 dB, two decimals and Double storage. Exact zero retains the previous frequency/Q field value; gain zero is accepted. These are recovered profile defaults, not all native custom preference settings. Untouched imported values stay unchanged. A shape change preserves Enabled unless explicitly supplied. Parameter redesign replaces preserved imported caches; raw bypass/latent edits retain coefficients. Raw coefficients accept a strict nonempty finite partial vector, merged independently for each role without rounding. Conversion to raw retains the current unbypassed section; new raw sections start at Unity. Every target is preflighted before one Undoable edit. Cache interpretation and upload stability guards remain independent.',
  fusion_filter_adjust:
    'Apply one stateless crossover parameter event. surface:field (default) uses native ordinary Q/Q2 or BQ-gain wheel behavior with factory steps0.04/0.1 and field-local notification publication; gain uses channel AdditionalGain, never ordinary channel gain. surface:graph permits primary q only on lowpass2/highpass2/peak/lowshelf2/highshelf2; independent events and changed fixed-source mirrors require these kinds on every selected destination. It uses the native Magnitude graph Q step0.04 and explicit final Text-to-Double getter, so an off-grid canonical value may round even at unchanged displayed Text. Commands start from passive canonical values and do not share human transient state. Field and graph-Q responses return surface, stored value and visible Text separately. Preset/channel/index are one-based. Both basis:each advances each role independently; basis:left/right mirrors only a changed source stored value. Field mirrors may update latent inactive destination parameters; graph mirrors require supported graph kinds. All destinations must be editable/unlinked and are preflighted before one Undoable mutation. A fixed-source canonical no-op retains source-kind and all structural/read-only validation, then skips peer kind admission and every edit. Unchanged peers retain exact cache/provenance/bypass/history. Only changed values redesign. No amplifier I/O. surface:graph-drag is a distinct strict position event requiring frequency, originAxisY and axisY only, with no parameter/direction/basis. It captures each role’s current filter as an independent origin; absolute frequency is an already-clamped supported plot-axis point (0.001–50,000 Hz), stored as Single without typed one-decimal/10 Hz conversion, while supported Peak/Shelf gain uses each captured origin plus the narrowed axis delta through native field formatting. Inactive gain and secondary frequency are preserved. The graph-drag response returns per-role numeric patches and stored frequency/gain. It is stateless per command, not a continuation of a human pointer gesture. Ordinary field gain’s visible Text may remain capped while its canonical model value changes; canonical publication determines edits, not a final-Text equality shortcut. Keyboard arrows remain separate; Input EQ uses fusion_eq_adjust and its own field profile, not these ordinary graph surfaces.',
  fusion_biquad_exchange:
    'Exchange two same-channel biquad parameter sets while preserving physical graph slots and read-only linked channels.',
  fusion_channel_copy:
    'Copy native HFD channel processing within a preset while retaining destination driver labels, measurements and additional gain.',
  fusion_preset_clear:
    'Clear preset gain, inversion, biquads and input FIR using HFD semantics; retain EQ, delays, output FIR, links and measurements. Undoable design edit only.',
  fusion_filter_move: 'Reorder a channel’s biquad cascade.',
  fusion_filter_reset: 'Reset a biquad to a bypassed unity section.',
  fusion_filter_delete:
    'Delete a crossover biquad using native HFD semantics: retain its slot identity, Enabled state and latent frequency/Q/gain/direction parameters, replace its response with Unity and make the slot available for Add. This is an undoable design edit without amplifier I/O; broader Reset remains separate.',
  fusion_channel_set:
    'Edit offline channel gain, polarity, mute, delay and labels atomically. Gain accepts a finite number or original raw Text, normalizes to two decimals in the native FA503 -125..24dB profile, and applies each role’s own AdditionalGain ceiling. A sole patch.gainWheel {direction:up|down,basis?:each|left|right} performs one sign-only0.1dB fresh-field event; Both defaults to each independently. Fixed source basis mirrors only a changed canonical result, through each destination’s own ceiling. Results report per-role Text and canonical value; continuous human wheel state remains local to the field. A sole delayUs or globalDelayUs accepts finite numbers or original raw Text through the native sample-quantized delay callback. Local bounds use the current trusted core runtime (fresh offline FA50319200us); Global uses that role’s saved maximum. Local notification also copies complete processing and both delay maxima to immediate linked followers, then fans that role’s current Global field Text to its three channels; Global callback only fans Global delay. Same-value notified edits can therefore create one undoable change. A sole patch.delayWheel {parameter:local|global,direction:up|down,basis?:each|left|right} sends one sign-only fresh-field event. Fixed-source canonical no-change does not mirror to the other role, but source notification effects still run. Bounds, runtime identity and wheel state cannot be supplied by callers. Value-only no-ops add no history. A sole patch.hardwareGain boolean invokes the conditional Hardware gain compensation callback: Off sets AdditionalGain0; On sets10 and caps Gain14dB. Trusted retained editor contexts can re-enable after Off; fresh availability requires a nonzero offset. These are undoable design edits, without amplifier I/O; live master-volume bounds remain separate.',
  fusion_copy: 'Copy a channel or preset between roles while retaining independent documents.',
  fusion_history: 'Undo or redo a design edit.',
  fusion_eq_default:
    'Stage native HFD Default EQ for a preset: default centers ending at16 kHz, zero gain, all bands enabled, retaining Q and whole-EQ bypass.',
  fusion_eq_copy_all:
    'Copy the selected preset’s nine input-EQ bands to all three design presets without changing their whole-EQ bypass flags or writing hardware.',
  fusion_eq_save_all:
    'Back up and save the selected design’s nine bands to all three presets on one or both amps, preserving live bypass flags and active preset, retaining mute.',
  fusion_eq_bank:
    'Inspect, copy, apply, write or clear the tab’s temporary three-preset EQ bank. Device copy reads all three physical sets; the clipboard survives disconnect but not reload.',
  fusion_workspace_storage:
    'Inspect, retry or flush workspace saves and export recovery JSON. file-transfer forwards validated file tools; project-sources opens local designs; project-directory prepares, commits and recovers actual files in already write-granted folders. These aliases support cached tool inventories. No amplifier writes.',
  fusion_project_sources:
    'Inspect granted local project database folders and recent projects, sort direct Config.xml project folders, or open fresh validated files into explicit design roles. Open requires trusted context, current document revision and a retry-stable requestId. Filesystem grants occur only through the human folder picker. Library references remain labeled snapshots. No hardware calls or permission prompts.',
  fusion_project_directory:
    'Save or Save As one explicit design role into a previously write-granted project folder. Prepare captures the revision, files and recovery copies before commit; review before authorizing replacements. Retry resumes that exact export; recovery restores originals while retaining introduced files. Status pages save history with offset/limit/includeArchived and record files/outcome paths with id/fileOffset/fileLimit. export-recovery creates a bounded file transfer; format:zip preserves raw binary recovery files. review-archive captures a terminal record; archive requires its reviewId, confirm:true and removeLocalRecovery:true, then removes browser recovery copies while retaining a historical replay receipt. Offer export first; a download does not establish durable external backup. Partial/uncertain records cannot be archived. Older records marked needsLocalAdoption expose metadata only: review-legacy prepares a bounded review and may open the local approval UI (localReviewOpened). adopt-legacy requires a locally minted human UI context; paired/manual/WebMCP calls cannot self-approve with confirm or owner arguments. After local approval, original IDs, owners and receipts remain intact and normal record operations work. Requires trusted workspace admission; never prompts for filesystem permissions or calls the amplifier.',
  fusion_eq_set:
    'Edit one of nine input EQ bands. Explicit frequency/Q/gain values commit through the EQ FloatEdit profile: 10–50,000 Hz/one decimal, Q 0.1–20/three decimals, gain −15.9…15.9 dB/two decimals; all use Double storage. Exact frequency/Q zero restores each role’s previous internal field value before formatting and Double reparse, so imported extra precision may round; gain zero is accepted. Type changes preserve band Enabled unless supplied. Whole-EQ enabled is separate. Untouched imported fields stay unchanged. redesign:true explicitly clears the preserved coefficient cache for a Reset even when numeric values are unchanged; default false retains bypass/no-op caches. All selected designs validate before one Undoable edit; no amplifier I/O.',
  fusion_eq_adjust:
    'Apply one stateless input-EQ wheel event to a one-based preset/band index. Frequency uses the native decade step, Q uses 0.04, gain uses 0.1; full FloatEdit bounds/format/reparse and Double storage apply. There is no output-channel AdditionalGain ceiling. Both basis:each adjusts independent values; basis:left/right mirrors a changed source value while preserving every role’s bypass and other fields. A source no-op never mirrors. Each command starts from a fresh passive display; continuous human gestures have separate opaque field state. All targets preflight before one Undoable edit; no amplifier I/O or native popup acceptance is implied.',
  fusion_fir_set:
    'Load or replace FIR taps while retaining bypass and placement unless enabled is explicit; browser clear unloads and bypasses. Alternatively supply only native plus target/preset: coupled Clear retains latent enabled/count while clearing shared input and selected output; placement changes Used without rewriting Enabled; enabled changes only its selected node. All are undoable design edits with no hardware calls.',
  fusion_measurement_set: 'Import or clear a channel frequency-response measurement.',
  fusion_hfd_measurement:
    'Inspect, explicitly convert or edit HFD crop/phase/Gaussian settings and shared preset crop snapshots; original impulse samples remain intact. For cached clients, action audio with nested audio arguments is a compatibility alias for fusion_audio, preserving its trusted context and one-based public numbering.',
  fusion_microphone:
    'Inspect, load, unload or configure the project-wide native microphone .txt/.dat file. Per-channel apply flags remain independent; explicit file loads/unloads update startup memory when supported. New inherits the current project file. Original measurements and amplifier state are unchanged.',
  fusion_analyze:
    'Calculate complex responses plus explicit native-view dB/phase with independent phase reference, common centering, Gaussian display and sums; view values are null outside the native grid. Optional layers returns the same raw/result/section/sum magnitude curves as the graph. selectedFilter is one-based or null for the whole electrical cascade; layers never mutate the design.',
  fusion_compile:
    'Validate a preset and return its encoded channel bytes without writing hardware.',
  fusion_time_analyze:
    'Calculate the same electrical or raw-measured impulse/step curves and included-channel sum as the UI, with peak-preserving time points and explicit native-parity warnings.',
  fusion_help:
    'Return the same bundled manual, verified General page, official vendor links and app-version metadata shown in Help, or show Help/Verification in the app. Resource inspection does not open links, fetch documents, prompt for permissions or contact a device. Only the fixed registered resources are available; arbitrary URLs are not accepted.',
  fusion_view:
    'Choose the visible workspace and graph view. Explicitly opening a Crossover output graph shares first-entry compensation and known-unloaded microphone initialization for only the selected role, with one combined Undo and no amplifier I/O. Qualified explicit graph entry repeats the immediate-source processing copy for a linked channel, including revisits; graph-option changes alone do not trigger that copy. graph.phase controls independent role-local Phase curve visibility (three channels) and phase-sum visibility without changing the design or canonical sum membership; Phase sum is separate from Magnitude sum. dbMin/dbMax set frequency-chart Y limits in dB, degrees or milliseconds. zoomRectangle:true requires all four axis bounds for the selected mode and invokes the same forward rectangle/history as the UI; zoomBack uses retained reverse history. Explicit Crossover Impulse time ranges, Fit and zoom write the selected channel’s saved native viewport in seconds with one Undo. Other modes and browser Reset do not write that native tuple.',
  fusion_noise:
    'Read session-local rotating-noise request status, or explicitly Start/Stop it on Left, Right or Both using native 08/1e. Every selected role is preflighted before writes. ACK confirms command acceptance, not audible output; per-role partial results remain explicit. No automatic Start, retry or rollback.',
  fusion_connect:
    'Connect an already permitted amplifier by identity or open its browser device chooser.',
  fusion_disconnect: 'Release USB sessions for the selected roles.',
  fusion_controls:
    'Change live controls from a fresh status packet, preserving other settings. outputMute:{channel:1|2|3,muted:boolean} is a standalone intent for one physical output and preserves the other outputs’ fresh mute bits; channelMutes explicitly replaces all three. Every target is preflighted before writes, including composite OEM permissions and actual per-role relative volumes. Native runtime input/volume/mute/preset remain available independently of mask bits. OLED maximum/dimmed brightness are 0..15 and require advertised OLED capability. standbyLedMode is encoded 0=OFF,1=100%,2=50%,3=25% and does not require OLED.',
  fusion_read_preset: 'Read the physical preset into the chosen document and save an exact backup.',
  fusion_backup: 'Save exact hardware preset sectors before any edit.',
  fusion_backups_list: 'List saved local recovery images and checksums.',
  fusion_backup_import:
    'Validate a standard 4 KiB IIR/input-EQ backup file and import it into the local recovery library. Returns its backupId; no amplifier connection or flash write is performed. FIR manifests use their separate recovery flow.',
  fusion_restore: 'Restore an identity-bound backup and verify every page, retaining mute.',
  fusion_upload:
    'Back up, mute, program and verify the selected preset on one or both amplifiers. Only its selected FIR placement is transferred; effective opposite-placement graph FIRs stay in the document and produce per-role/preset warnings in fir metadata. The previous master mute state is restored after successful verification.',
  fusion_device_read:
    'Read fresh device options, hardware/accessory overview, limiter configuration and power statistics.',
  fusion_power:
    'Request DSP on while retaining mute and checking reported state. Physical ON recovery remains unqualified. DSP off is currently blocked for every unqualified firmware; read power without changing it through fusion_device_read.',
  fusion_device_defaults:
    'Review and apply the full native FA503 Device Defaults transaction on explicitly chosen Left, Right or both amplifiers. This is separate from EQ Default or clearing a design. review captures exact roles, sessions, identities and settings and shows the shared local review. apply requires its reviewId and confirm:true; every target must be unlocked regardless of OEM permissions. All original 05/06/66 records are durably saved before any write. Steps reset device settings, mixer, limiter configuration and display with exact native encodings and readback; outputs remain muted. Default settings disable the soft-clip limiter and bridge mode. status returns cached paged metadata without storage/device I/O; refresh-history reads local recovery storage only. export-record returns one complete detached recovery journal. review-recovery and restore require a new explicit confirmed review for the original physical identities, restore only Defaults-owned fields and retain current unrelated settings/runtime and global mute. Replaying a consumed request reports its existing ledger without repeating hardware writes. Unconfirmed writes are never retried or rolled back automatically. Physical Defaults/recovery remain unqualified.',
  fusion_limiter_set: 'Back up, update and verify output power, impedance and limiter timings.',
  fusion_limiter_editor:
    'Use the shared HFD limiter editor on explicit Left, Right or Both targets. status is cached with no I/O. load reads fresh independent drafts; edits change the same visible UI state and require expectedRevision. Channels are one-based. Normal attack/release controls update all three coefficients through native six-decimal Text; Expert mode retains individual coefficient Text. Update recalculates thresholds from power/load even in Expert mode. review captures fixed roles, identities and drafts; apply requires its reviewId and confirm:true. All backups and fresh preflights complete before common mute and a single verified configuration write per role. Outputs stay muted; partial outcomes remain per role with no automatic retry. Consumed reviews are page-lifetime receipts; after reload old IDs are rejected, never resumed. Physical native limiter acceptance remains unqualified.',
  fusion_configuration_backup: 'Save exact device configuration for recovery.',
  fusion_configuration_backups: 'List device configuration recovery images.',
  fusion_configuration_restore: 'Restore exact device configuration and retain mute.',
};
TOOL_DESCRIPTIONS.fusion_configuration_backup =
  'Save exact device configuration and status for recovery before limiter edits.';
TOOL_DESCRIPTIONS.fusion_project_directory = TOOL_DESCRIPTIONS.fusion_project_directory.replace(
  'never prompts for filesystem permissions or calls the amplifier.',
  'never prompts for filesystem permissions. New Prepare requests default to read-only capture of fresh native settings and three EQ banks for an initially connected target. metadata:design explicitly saves the design without reading hardware; exportId reuses an owned frozen Save artifact. Captures bind the initial session/identity and fail on replacement or stale design. Prepared-request replay, Commit, Retry and Recover use retained files and never recapture the amplifier.',
);
TOOL_DESCRIPTIONS.fusion_project_directory +=
  ' Folder Save records the trusted current UI preset in Config.xml and its matching sidecar, retaining the captured delay values. Only after a fresh verified writer completes does it reconcile that role current-preset Global delays as one independent Undo step; Mirror does not extend the target. nativeSavePostState reports the page-local outcome. Downloads and Prepare are passive. Stale or partial/unknown attempts do not fabricate a normal return; a completed receipt never reapplies the workspace effect after Undo or reload. A workspace persistence retry does not rewrite files. Files can therefore precede the reconciled open design; prepare a new Save to write its newer values.';
TOOL_DESCRIPTIONS.fusion_file_export +=
  ' The explicit native-project-save workflow resolves an owned Save artifact by id and slot; it may perform its first read-only settings/EQ capture. All ordinary project export workflows remain document snapshots without hardware calls.';
TOOL_DESCRIPTIONS.fusion_configuration_backups =
  'List locally saved device configuration recovery images.';
TOOL_DESCRIPTIONS.fusion_configuration_restore =
  'Restore an identity-bound device configuration and verify every byte, retaining mute.';
TOOL_DESCRIPTIONS.fusion_device_read =
  'Read fresh device options, hardware/accessory overview, native OEM protection report, limiter configuration and power statistics. Mask inventory and permitted operations are separate. Optional firmware actions inspect/status/clear files or preview up to 50 packets without a connection or device calls. usb-status/usb-choose/usb-revalidate/usb-clear share the browser runtime-descriptor verifier; choose requires one connected role and a manual browser gesture. These metadata operations never open, claim or transfer to a USB device. Proof requires the exact observed USB serial and captured EEPROM identity, with no family inference from a filename/product label. A valid runtime proof does not establish bootloader correlation, recovery or programming; programming remains unavailable.';
TOOL_DESCRIPTIONS.fusion_device_read +=
  ' firmware runtime-status/runtime-clear expose cached identity reports without I/O. runtime-read uses the exact captured live session or previously granted remembered HID interface, never a chooser or VID/PID search. It reads only matched configuration, amplifier metadata, DSP filename and EEPROM serial, with fixed role/session/owner fences. Both reports publish together or neither. Exact reported5.82/core5.5 can be identified without admitting controls; installed-image SHA and descriptor family are not established by these reports. File stages may separately recognize exact known content SHA profiles; those never prove the running image. Programming/reconnect/recovery qualification remains incomplete. Nested update-status/history/export expose owner-bound cached workflow and bounded journal pages. update-review requires exact stageIds for every intended role; update-apply requires its reviewId and confirm:true. update-discard cancels a pending review; update-review-recovery explicitly reviews a consumed partial record. Physical availability is source-qualified, never selected by tool arguments, filename or runtime version; unavailable profiles reject before device I/O. These actions share the human firmware workflow and preserve consumed outcomes.';
TOOL_DESCRIPTIONS.fusion_device_read +=
  ' Optional auth namespace uses the shared human authentication controller: status, unlock, password-change, email-read, email-set, oem-propose, oem-save and clear. Credentials use explicit ascii/windows-1252/utf-8/hex encoding; password-change requires exact next/confirm plus explicit recovery email. Choose one role for credentials; only status/clear accept both. Status never contains credentials or email. Email bytes are returned only by explicit email-read. OEM proposal is read-only and bound to its role/session; Save consumes its ID once and rechecks fresh permissions and prior mask. No password or OEM write is retried automatically.';
TOOL_DESCRIPTIONS.fusion_device_read +=
  ' auth:{action:"recovery",recovery:{...}} exposes the shared forgotten OEM-password workflow: status/clear, review (new-challenge or explicitly confirmed installed-challenge), confirm-challenge, review-code, submit-code and discard-code. Choose one role for review/writes. Reviews bind session, identity and recovery revision; challenge installation and reset consume explicit confirmed tokens without retries. Only explicit review-code returns the canonical support-code prefix; status/errors never contain the submitted code. No vendor message or code derivation is performed. Physical recovery on firmware5.7 and the automatic support-request transport remain unqualified.';
TOOL_DESCRIPTIONS.fusion_device_read +=
  ' Optional noise namespace forwards the shared fusion_noise status/set command, using the same explicit top-level target. Noise state is session-local request/ACK metadata, not acoustic readback. This compatibility tool accepts mutating actions and is not annotated read-only.';
TOOL_DESCRIPTIONS.fusion_power =
  'Request DSP on while retaining mute and checking reported state. Physical ON recovery remains unqualified. DSP off is blocked for every unqualified firmware; read power without changing it through fusion_device_read.';
TOOL_DESCRIPTIONS.fusion_limiter_set =
  'Legacy browser extension for independent per-channel limiter timings and wider power/load ranges. Uses full-precision arithmetic rather than HFD coefficient Text. For the shared native editor and coordinated review use fusion_limiter_editor. Back up, update, verify configuration and retain mute.';
export const TOOL_DEFINITIONS = Object.entries(schemas).map(([name, schema]) => ({
  name: name as ToolName,
  description: TOOL_DESCRIPTIONS[name as ToolName],
  // Describe accepted caller INPUTS. Output schemas mark defaulted fields as
  // required even though the executor deliberately accepts their omission.
  inputSchema: { ...z.toJSONSchema(schema, { io: 'input' }), type: 'object' as const },
  annotations: {
    readOnlyHint: [
      'fusion_state',
      'fusion_project_export',
      'fusion_analyze',
      'fusion_time_analyze',
      'fusion_compile',
      'fusion_backups_list',
      'fusion_fir_backups',
      'fusion_configuration_backups',
      'fusion_measurement_export',
      'fusion_project_files',
      'fusion_library_list',
      'fusion_preview_filter',
    ].includes(name),
    untrustedContentHint: ['fusion_state', 'fusion_project_export', 'fusion_backups_list'].includes(
      name,
    ),
  },
}));
const roles = (t: 'left' | 'right' | 'both'): Slot[] => (t === 'both' ? ['left', 'right'] : [t]);
const replaceDocument = (target: Project, incoming: Project) => {
  assertProjectLinks(incoming);
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, structuredClone(incoming));
};
/** Prepare every role before publication; native open must never persist a raw
 * intermediate or flatten different runtime-preset outcomes into one project. */
function replaceOpenedProject(
  adapter: ToolAdapter,
  slots: Slot[],
  incoming: Project,
  intent: ProjectReplacementIntent,
) {
  if (!adapter.prepareProjectOpen) {
    adapter.edit(slots, (project) => replaceDocument(project, incoming), {
      synchronizeLinks: false,
    });
  } else {
    if (slots.length > 1 && !adapter.editByRole)
      throw new Error('Explicit-role project opening is unavailable in this client');
    const finals = new Map(
      slots.map((slot) => [
        slot,
        projectSchema.parse(
          adapter.prepareProjectOpen!(structuredClone(incoming), slot, { ...intent }),
        ),
      ]),
    );
    if (adapter.editByRole)
      adapter.editByRole(
        slots,
        (project, slot) => {
          const final = finals.get(slot);
          if (!final) throw new Error('Project opening belongs to another role');
          replaceDocument(project, final);
        },
        { synchronizeLinks: false },
      );
    else
      adapter.edit(slots, (project) => replaceDocument(project, finals.get(slots[0])!), {
        synchronizeLinks: false,
      });
  }
  // Final canonical data is already published. This hook owns visits and UI only.
  adapter.documentsReplaced?.(slots, intent);
}
/** Bound the manifest before the hosted MCP response JSON-escapes it again. */
function transferPage(status: FileTransferStatus, offset = 0, limit = 100) {
  const { files, lastError, ...rest } = status;
  return {
    ...rest,
    ...(lastError ? { lastError: lastError.slice(0, 2048) } : {}),
    fileCount: files.length,
    fileOffset: offset,
    files: files.slice(offset, offset + limit),
    nextFileOffset: offset + limit < files.length ? offset + limit : null,
  };
}
export function createToolExecutor(adapter: ToolAdapter) {
  return async function execute(
    name: string,
    input: unknown,
    execution?: AbortSignal | ToolExecutionContext,
  ): Promise<unknown> {
    const context =
      execution && 'owner' in execution ? (execution as ToolExecutionContext) : undefined;
    const signal =
      context?.signal ?? (context ? undefined : (execution as AbortSignal | undefined));
    if (!(name in schemas)) return { ok: false, error: 'Unknown tool' };
    const key = name as ToolName,
      parsed = schemas[key].safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        error:
          name === 'fusion_device_read' &&
          input &&
          typeof input === 'object' &&
          Object.hasOwn(input, 'auth')
            ? 'Invalid authentication action, credential fields or target scope'
            : parsed.error.message.slice(0, 16384),
      };
    // Runtime schemas are the authority; the switch narrows each tool separately.
    const a = parsed.data as Record<string, unknown>,
      state = adapter.state();
    const get = (s: Slot) => {
      const l = adapter.connections()[s];
      if (!l) throw new Error(`${s} amplifier is not connected`);
      return l;
    };
    const firUploadScope = (slots: Slot[], presets: number[]) => {
      const scope = slots.flatMap((slot) =>
        presets.map((preset) => {
          const plan = planFirActivation(state.documents[slot].presets[preset - 1], 0);
          return {
            slot,
            preset,
            placement: plan.placement === 0 ? ('input' as const) : ('output' as const),
            warnings: plan.warnings,
          };
        }),
      );
      const warnings = scope.flatMap((role) =>
        role.warnings.map((warning) => `${role.slot} · Preset ${role.preset}: ${warning}`),
      );
      if (warnings.length) adapter.message(warnings.join(' '));
      return scope;
    };
    const fileAccess = () => {
      if (!context)
        throw new Error('File transfers require a trusted browser or authenticated bridge context');
      const files = adapter.files;
      if (!files) throw new Error('File transfer storage is unavailable in this client');
      return { files, actor: context };
    };
    try {
      if (context) parseExecutionPrincipal({ owner: context.owner, scope: context.scope });
      signal?.throwIfAborted();
      if (
        [
          'fusion_filter_add',
          'fusion_filter_set',
          'fusion_filter_adjust',
          'fusion_filter_move',
          'fusion_filter_reset',
          'fusion_filter_delete',
        ].includes(key)
      ) {
        for (const role of roles(a.target as 'left' | 'right' | 'both')) {
          const pr = state.documents[role].presets[Number(a.preset) - 1],
            ch = Number(a.channel) - 1;
          if (rootChannel(pr, ch) !== ch)
            throw new Error(
              `Channel ${ch + 1} is linked; edit master channel ${rootChannel(pr, ch) + 1} or unlink it first`,
            );
        }
      }
      switch (key) {
        case 'fusion_audio': {
          const p = schemas.fusion_audio.parse(a),
            capture = adapter.capture;
          if (!context)
            throw new Error(
              'Audio capture requires a trusted browser or authenticated bridge context',
            );
          if (!capture) throw new Error('Audio capture is unavailable in this client');
          switch (p.action) {
            case 'status':
              return { ok: true, capture: publicCaptureSnapshot(capture.getSnapshot()) };
            case 'devices':
              return { ok: true, devices: await capture.devices(context) };
            case 'choose-output':
              return { ok: true, outputDeviceId: await capture.chooseOutput(context) };
            case 'configure':
              return {
                ok: true,
                capture: publicCaptureSnapshot(
                  capture.configure(context, {
                    ...p.config!,
                    inputChannel: p.config!.inputChannel - 1,
                    outputChannel: p.config!.outputChannel - 1,
                  }),
                ),
              };
            case 'enable':
              return { ok: true, capture: publicCaptureSnapshot(await capture.enable(context)) };
            case 'start':
              return {
                ok: true,
                capture: publicCaptureSnapshot(
                  capture.start(context, {
                    requestId: p.requestId!,
                    target: {
                      ...p.target!,
                      preset: p.target!.preset - 1,
                      channel: p.target!.channel - 1,
                    },
                    expectedRevision: p.expectedRevision!,
                    ...(p.name === undefined ? {} : { name: p.name }),
                  }),
                ),
              };
            case 'cancel':
              return {
                ok: true,
                capture: publicCaptureSnapshot(capture.cancel(context, p.requestId)),
              };
            case 'disable':
              return { ok: true, capture: publicCaptureSnapshot(await capture.disable(context)) };
            case 'apply':
              return {
                ok: true,
                capture: publicCaptureSnapshot(
                  await capture.apply(context, p.requestId!, p.expectedRevision!),
                ),
              };
            case 'discard':
              return {
                ok: true,
                capture: publicCaptureSnapshot(capture.discard(context, p.requestId!)),
              };
          }
        }
        case 'fusion_state':
          return {
            ok: true,
            documentRevision: adapter.files?.revision() ?? state.documentRevision ?? 0,
            view: adapter.viewState?.(),
            selection: {
              slot: state.slot,
              preset: state.preset + 1,
              channel: state.channel + 1,
              filter: state.filter + 1,
              linkedEdits: state.linkedEdits,
              linkedControls: state.linkedControls,
            },
            projects: a.includeProjects
              ? state.documents
              : Object.fromEntries(
                  SLOTS_LOCAL.map((s) => [
                    s,
                    {
                      name: state.documents[s].name,
                      model: 'FA503',
                      presets: state.documents[s].presets.map((p) => ({
                        name: p.name,
                        channels: p.channels.map((c) => ({
                          name: c.name,
                          gain: c.gain,
                          delayUs: c.delayUs,
                          invert: c.invert,
                          muted: c.muted,
                        })),
                      })),
                    },
                  ]),
                ),
            connections: Object.fromEntries(
              Object.entries(adapter.connections()).map(([s, l]) => [
                s,
                {
                  identity: l.identity,
                  preset: l.status.preset,
                  volume: l.status.volume,
                  muted: l.status.muted,
                  input: l.status.input,
                  locked: l.status.locked,
                  metering: decodeMetering(l.status),
                  health: decodeHealth(l.status),
                  powerOff: dspPowerOffAvailability(l.identity.firmware),
                },
              ]),
            ),
          };
        case 'fusion_select': {
          const p = schemas.fusion_select.parse(a);
          adapter.choose({
            ...p,
            ...(p.preset ? { preset: p.preset - 1 } : {}),
            ...(p.channel ? { channel: p.channel - 1 } : {}),
            ...(p.filter ? { filter: p.filter - 1 } : {}),
          });
          break;
        }
        case 'fusion_project_new': {
          const p = schemas.fusion_project_new.parse(a);
          adapter.edit(roles(p.target), (project) =>
            replaceDocument(project, inheritProjectMicrophone(newProject(p.name), project)),
          );
          adapter.documentsReplaced?.(roles(p.target), { kind: 'new-project' });
          break;
        }
        case 'fusion_rename': {
          const p = schemas.fusion_rename.parse(a);
          adapter.edit(roles(p.target), (project) => {
            if (p.preset === undefined) project.name = p.name;
            else project.presets[p.preset - 1].name = p.name;
          });
          break;
        }
        case 'fusion_project_import': {
          const p = schemas.fusion_project_import.parse(a),
            decoded = parseProjectOpen(p.content, p.name),
            project = decoded.project;
          replaceOpenedProject(
            adapter,
            roles(p.target),
            project,
            decoded.format === 'hfd-native'
              ? { kind: 'native-file-open', route: 'dialog' }
              : { kind: 'snapshot' },
          );
          break;
        }
        case 'fusion_project_import_folder': {
          const p = schemas.fusion_project_import_folder.parse(a),
            decoded = importProjectFolderOpen(p.files, p.name),
            project = decoded.project;
          replaceOpenedProject(
            adapter,
            roles(p.target),
            project,
            decoded.format === 'hfd-native'
              ? { kind: 'native-file-open', route: 'dialog' }
              : { kind: 'snapshot' },
          );
          adapter.message(project.warnings.at(-1) ?? 'HFD folder imported.');
          return { ok: true, warnings: project.warnings };
        }
        case 'fusion_project_files': {
          const p = schemas.fusion_project_files.parse(a);
          return { ok: true, files: projectFiles(state.documents[p.slot]) };
        }
        case 'fusion_project_save': {
          const p = schemas.fusion_project_save.parse(a),
            saves = adapter.nativeProjectSave;
          if (!context)
            throw new Error('Project Save capture requires trusted workspace admission');
          if (!saves) throw new Error('Project Save capture is unavailable in this client');
          if (p.action === 'status') return { ok: true, saves: saves.status(context) };
          if (p.action === 'stage') {
            const { action: _action, ...input } = p;
            return { ok: true, capture: saves.stage(input, context) };
          }
          if (p.action === 'release') {
            saves.release(p.id, context);
            return { ok: true, saves: saves.status(context) };
          }
          const artifact = await saves.resolve(p.id, context);
          return {
            ok: true,
            id: artifact.id,
            expectedRevision: artifact.expectedRevision,
            roles: artifact.roles.map((role) => ({
              slot: role.slot,
              source: role.source,
              identity: role.identity,
              capturedAt: role.capturedAt,
              fileCount: role.files.length,
              paths: role.files.slice(0, 20).map((file) => file.path),
              omittedFiles: Math.max(0, role.files.length - 20),
            })),
          };
        }
        case 'fusion_library_list': {
          const p = schemas.fusion_library_list.parse(a);
          return {
            ok: true,
            projects: (await listProjects())
              .filter((r) => p.includeRemoved || !r.trashed)
              .map(({ project, ...r }) => r),
          };
        }
        case 'fusion_library_save': {
          const p = schemas.fusion_library_save.parse(a),
            r = await saveProject(state.documents[p.slot]);
          return { ok: true, id: r.id, name: r.name, utc: r.utc };
        }
        case 'fusion_library_open': {
          const p = schemas.fusion_library_open.parse(a),
            r = await getProject(p.id);
          if (!r || r.trashed) throw new Error('Saved project not found');
          if (
            adapter.state().documents !== state.documents ||
            adapter.state().documentRevision !== state.documentRevision
          )
            throw new Error(
              'The design changed while opening the snapshot; open it again for the current design',
            );
          adapter.edit(roles(p.target), (d) => replaceDocument(d, r.project), {
            synchronizeLinks: false,
          });
          adapter.documentsReplaced?.(roles(p.target), { kind: 'snapshot' });
          break;
        }
        case 'fusion_library_remove': {
          const p = schemas.fusion_library_remove.parse(a);
          await trashProject(p.id, p.removed);
          break;
        }
        case 'fusion_project_export': {
          const p = schemas.fusion_project_export.parse(a),
            project = state.documents[p.slot];
          return {
            ok: true,
            name: project.name,
            content: p.format === 'json' ? JSON.stringify(project, null, 2) : exportHfd(project),
          };
        }
        case 'fusion_filter_palette': {
          const p = schemas.fusion_filter_palette.parse(a);
          if (!adapter.palette)
            throw new Error('Visual filter palette is unavailable in this client');
          await adapter.palette(p);
          break;
        }
        case 'fusion_preview_filter': {
          const p = schemas.fusion_preview_filter.parse(a),
            filter = { ...newFilter(p.filter.kind), ...p.filter, enabled: true },
            coefficients = design(filter);
          const candidate = newProject().presets[0].channels[0];
          candidate.filters[0] = filter;
          encodeChannel(candidate);
          return {
            ok: true,
            coefficients,
            points: p.frequencies.map((frequency) => {
              const [real, imaginary] = response(coefficients, frequency);
              return {
                frequency,
                real,
                imaginary,
                db: 20 * Math.log10(Math.max(1e-12, Math.hypot(real, imaginary))),
                phaseDegrees: (Math.atan2(imaginary, real) * 180) / Math.PI,
              };
            }),
          };
        }
        case 'fusion_filter_add': {
          const p = schemas.fusion_filter_add.parse(a);
          adapter.edit(roles(p.target), (d) => {
            const c = d.presets[p.preset - 1].channels[p.channel - 1],
              i = c.filters.findIndex(isUnusedBiquad);
            if (i < 0) throw new Error('No unused biquad slots remain');
            c.filters[i] = {
              ...editManualFilter(newFilter(p.kind), { frequency: p.frequency }),
              id: c.filters[i].id,
              sourceId: c.filters[i].sourceId,
            };
            if (i === 0) c.coefficientCache = 'base';
          });
          break;
        }
        case 'fusion_filter_set': {
          const p = schemas.fusion_filter_set.parse(a);
          // Validate all independent vectors before the adapter can publish a
          // paired edit. A partial raw patch must never use the other role's cache.
          const changed = roles(p.target).filter((role) => {
            const f =
              state.documents[role].presets[p.preset - 1].channels[p.channel - 1].filters[
                p.index - 1
              ];
            const next = editManualFilter(f, p.patch, { redesign: p.redesign });
            return (
              JSON.stringify(next) !== JSON.stringify(f) ||
              (['b0', 'b1', 'b2', 'f1', 'f2'] as const).some(
                (key) => !Object.is(next.coefficients?.[key], f.coefficients?.[key]),
              )
            );
          });
          if (changed.length)
            adapter.edit(changed, (doc) => {
              const c = doc.presets[p.preset - 1].channels[p.channel - 1];
              const next = editManualFilter(c.filters[p.index - 1], p.patch, {
                redesign: p.redesign,
              });
              c.filters[p.index - 1] = next;
              if (p.redesign && next.kind !== 'raw' && !p.patch.coefficients && p.index === 1)
                c.coefficientCache = 'base';
            });
          break;
        }
        case 'fusion_filter_adjust': {
          const p = schemas.fusion_filter_adjust.parse(a);
          if (p.surface === 'graph-drag') {
            if (!adapter.editByRole)
              throw new Error('Explicit-role graph drag editing is unavailable in this client');
            const capture = captureManualFilterDrag(
              state.documents,
              roles(p.target),
              { presetIndex: p.preset - 1, channelIndex: p.channel - 1, filterIndex: p.index - 1 },
              state.documentRevision,
            );
            const plan = planManualFilterDrag(
              state.documents,
              capture,
              { frequency: p.frequency, originAxisY: p.originAxisY, axisY: p.axisY },
              state.documentRevision,
            );
            if (plan.changedSlots.length)
              adapter.editByRole(plan.changedSlots, (project, slot) =>
                applyManualFilterDrag(project, slot, plan),
              );
            return {
              ok: true,
              surface: p.surface,
              changed: plan.changedSlots.length > 0,
              roles: plan.roles.map(({ slot, beforeFilter, nextFilter, patch, changed }) => ({
                slot,
                before: { frequency: beforeFilter.frequency, gain: beforeFilter.gain },
                value: { frequency: nextFilter.frequency, gain: nextFilter.gain },
                patch,
                changed,
              })),
            };
          }
          const plan = planManualFilterWheel(state.documents, roles(p.target), {
            presetIndex: p.preset - 1,
            channelIndex: p.channel - 1,
            filterIndex: p.index - 1,
            parameter: p.parameter,
            direction: p.direction === 'up' ? 1 : -1,
            basis: p.basis,
            surface: p.surface,
          });
          if (plan.changedSlots.length)
            adapter.edit(plan.changedSlots, (project) => applyManualFilterWheel(project, plan));
          return {
            ok: true,
            changed: plan.changedSlots.length > 0,
            basis: p.basis,
            surface: p.surface,
            roles: plan.roles.map(({ slot, before, value, text, changed }) => ({
              slot,
              before,
              value,
              text,
              changed,
            })),
          };
        }
        case 'fusion_biquad_exchange': {
          const p = schemas.fusion_biquad_exchange.parse(a);
          adapter.edit(roles(p.target), (doc) =>
            exchangeBiquads(doc, p.preset - 1, p.channel - 1, p.first - 1, p.second - 1),
          );
          break;
        }
        case 'fusion_channel_copy': {
          const p = schemas.fusion_channel_copy.parse(a);
          adapter.edit(roles(p.target), (doc) =>
            copyChannelProcessing(doc, p.preset - 1, p.source - 1, p.destination - 1),
          );
          break;
        }
        case 'fusion_preset_clear': {
          const p = schemas.fusion_preset_clear.parse(a);
          adapter.edit(roles(p.target), (doc) => clearPreset(doc, p.preset - 1));
          break;
        }
        case 'fusion_filter_move': {
          const p = schemas.fusion_filter_move.parse(a);
          adapter.edit(roles(p.target), (doc) => {
            const filters = doc.presets[p.preset - 1].channels[p.channel - 1].filters;
            const [f] = filters.splice(p.from - 1, 1);
            filters.splice(p.to - 1, 0, f);
          });
          break;
        }
        case 'fusion_filter_reset': {
          const p = schemas.fusion_filter_reset.parse(a);
          adapter.edit(roles(p.target), (doc) => {
            const c = doc.presets[p.preset - 1].channels[p.channel - 1],
              id = c.filters[p.index - 1].sourceId;
            c.filters[p.index - 1] = { ...newFilter(), sourceId: id };
          });
          break;
        }
        case 'fusion_filter_delete': {
          const p = schemas.fusion_filter_delete.parse(a);
          adapter.edit(roles(p.target), (doc) =>
            deleteBiquad(doc, p.preset - 1, p.channel - 1, p.index - 1),
          );
          break;
        }
        case 'fusion_channel_cache': {
          const p = schemas.fusion_channel_cache.parse(a);
          adapter.edit(roles(p.target), (d) =>
            resolveGainCache(d.presets[p.preset - 1].channels[p.channel - 1], p.interpretation),
          );
          break;
        }
        case 'fusion_channel_link': {
          const p = schemas.fusion_channel_link.parse(a);
          adapter.edit(roles(p.target), (d) =>
            linkChannel(d.presets[p.preset - 1], p.channel - 1, p.to === null ? null : p.to - 1),
          );
          break;
        }
        case 'fusion_channel_set': {
          const p = schemas.fusion_channel_set.parse(a);
          if (!adapter.editByRole)
            throw new Error('Explicit-role channel editing is unavailable in this client');
          const slots = roles(p.target),
            presetIndex = p.preset - 1,
            channelIndex = p.channel - 1;
          const { gainWheel, delayWheel, ...ordinaryPatch } = p.patch;
          const plan = planChannelEdit(
            state.documents,
            slots,
            {
              presetIndex,
              channelIndex,
              patch: gainWheel
                ? { gainWheel: { ...gainWheel, direction: gainWheel.direction === 'up' ? 1 : -1 } }
                : delayWheel
                  ? {
                      delayWheel: {
                        ...delayWheel,
                        direction: delayWheel.direction === 'up' ? 1 : -1,
                      },
                    }
                  : ordinaryPatch,
            },
            state.documentRevision,
            {
              hardwareGainContext: Object.fromEntries(
                slots.map((slot) => [
                  slot,
                  adapter.hardwareGainContext?.({ slot, presetIndex, channelIndex }),
                ]),
              ),
              delayContext:
                delayWheel || p.patch.delayUs !== undefined || p.patch.globalDelayUs !== undefined
                  ? Object.fromEntries(
                      slots.map((slot) => [
                        slot,
                        adapter.delayContext?.({ slot, presetIndex, channelIndex }),
                      ]),
                    )
                  : undefined,
            },
          );
          if (plan.changedSlots.length)
            adapter.editByRole(
              plan.changedSlots,
              (project, slot) => applyChannelEdit(project, slot, plan),
              { synchronizeLinks: plan.synchronizeLinks },
            );
          if (p.patch.hardwareGain !== undefined) {
            adapter.retainHardwareGainContexts?.(
              plan.roles.map((role) => ({
                slot: role.slot,
                presetIndex,
                channelIndex,
                channelId: role.context[channelIndex].id,
              })),
            );
            return {
              ok: true,
              changed: plan.changedSlots.length > 0,
              roles: plan.roles.map((role) => ({
                slot: role.slot,
                changed: role.changed,
                value: role.value,
                hardwareGain: role.hardwareGain!.result,
              })),
            };
          }
          if (p.patch.gain !== undefined || p.patch.gainWheel !== undefined)
            return {
              ok: true,
              changed: plan.changedSlots.length > 0,
              roles: plan.roles.map((role) => ({
                slot: role.slot,
                changed: role.changed,
                gain: role.gainResult ?? role.gainWheelResult,
              })),
            };
          if (
            p.patch.delayUs !== undefined ||
            p.patch.globalDelayUs !== undefined ||
            p.patch.delayWheel !== undefined
          )
            return {
              ok: true,
              changed: plan.changedSlots.length > 0,
              roles: plan.roles.map((role) => ({
                slot: role.slot,
                changed: role.changed,
                delay: role.delayResult ?? role.delayWheelResult,
              })),
            };
          if (!plan.changedSlots.length) return { ok: true, changed: false };
          break;
        }
        case 'fusion_copy': {
          const p = schemas.fusion_copy.parse(a),
            source = structuredClone(state.documents[p.from]);
          if (p.channel)
            adapter.edit([p.to], (doc) => {
              doc.presets[(p.destinationPreset ?? p.preset) - 1].channels[p.channel! - 1] =
                source.presets[p.preset - 1].channels[p.channel! - 1];
            });
          else
            adapter.edit(
              [p.to],
              (doc) =>
                copyPresetBetween(source, p.preset - 1, doc, (p.destinationPreset ?? p.preset) - 1),
              { synchronizeLinks: false },
            );
          adapter.measurementsReplaced?.(
            [p.to],
            (p.destinationPreset ?? p.preset) - 1,
            p.channel ? [p.channel - 1] : [0, 1, 2],
          );
          break;
        }
        case 'fusion_history': {
          schemas.fusion_history.parse(a).action === 'undo' ? adapter.undo() : adapter.redo();
          break;
        }
        case 'fusion_workspace_storage': {
          const p = schemas.fusion_workspace_storage.parse(a),
            storage = adapter.persistence;
          if (p.action === 'file-transfer')
            return execute(p.command!, p.arguments ?? {}, execution);
          if (p.action === 'project-sources')
            return execute('fusion_project_sources', p.sources, execution);
          if (p.action === 'project-directory')
            return execute('fusion_project_directory', p.directory, execution);
          if (!storage) throw new Error('Workspace persistence is unavailable in this client');
          if (p.action === 'retry') await storage.retry();
          if (p.action === 'flush') await storage.flush();
          return {
            ok: true,
            status: storage.status(),
            ...(p.action === 'recovery-export' ? { content: storage.recovery() } : {}),
          };
        }
        case 'fusion_project_directory': {
          const p = schemas.fusion_project_directory.parse(a),
            writer = adapter.directoryWriter;
          if (!writer) throw new Error('Project folder saving is unavailable in this client');
          if (!context)
            throw new Error(
              'Project folder saving requires a trusted browser or authenticated bridge context',
            );
          const principal = { owner: context.owner, scope: context.scope };
          if (p.action === 'retry-storage') {
            await writer.retryStorage();
            return { ok: true, directory: directorySnapshotPage(writer.getSnapshot()) };
          }
          if (p.action === 'status' && !p.id) {
            try {
              await writer.hydrate();
            } catch {
              /* Report the bounded storage error. */
            }
            return { ok: true, directory: directorySnapshotPage(writer.getSnapshot(), p) };
          }
          await writer.hydrate();
          signal?.throwIfAborted();
          if (p.action === 'status')
            return {
              ok: true,
              proposal: directoryProposalPage(await writer.status(p.id!, principal), p),
            };
          if (p.action === 'forget-root') {
            await writer.forgetRoot(p.rootId);
            return { ok: true, directory: directorySnapshotPage(writer.getSnapshot()) };
          }
          if (p.action === 'prepare') {
            const binding = {
              slot: p.slot,
              expectedRevision: p.expectedRevision,
              requestId: p.requestId,
              principal,
              ...(p.exportId ? { exportId: p.exportId } : {}),
              ...(p.metadata ? { metadata: p.metadata } : {}),
            };
            return {
              ok: true,
              proposal: directoryProposalPage(
                await writer.prepare(
                  p.mode === 'save'
                    ? { ...binding, mode: 'save' }
                    : { ...binding, mode: 'save-as', rootId: p.rootId!, folderName: p.folderName! },
                ),
              ),
            };
          }
          if (p.action === 'commit')
            return {
              ok: true,
              receipt: directoryProposalPage(
                await writer.commit(p.id, principal, { allowOverwrite: p.allowOverwrite }),
              ),
            };
          if (p.action === 'retry')
            return {
              ok: true,
              receipt: directoryProposalPage(await writer.retry(p.id, principal)),
            };
          if (p.action === 'recover')
            return {
              ok: true,
              receipt: directoryProposalPage(await writer.recover(p.id, principal)),
            };
          if (p.action === 'review-archive') {
            const review = await writer.reviewArchive(p.id, principal);
            return {
              ok: true,
              review: { ...review, proposal: directoryProposalPage(review.proposal) },
            };
          }
          if (p.action === 'review-legacy') {
            if (!writer.reviewLegacy)
              throw new Error('Older-record access review is unavailable in this client');
            const review = await writer.reviewLegacy(p.id, principal);
            return {
              ok: true,
              review: { ...review, proposal: directoryProposalPage(review.proposal) },
              localReviewOpened: adapter.reviewDirectoryLegacy?.(review) ?? false,
            };
          }
          if (p.action === 'adopt-legacy') {
            if (!writer.adoptLegacy)
              throw new Error('Older-record access review is unavailable in this client');
            return {
              ok: true,
              proposal: directoryProposalPage(
                await writer.adoptLegacy(p.reviewId, principal, { confirm: p.confirm }),
              ),
            };
          }
          if (p.action === 'archive')
            return {
              ok: true,
              receipt: directoryProposalPage(
                await writer.archive(p.reviewId, principal, {
                  confirm: p.confirm,
                  removeLocalRecovery: p.removeLocalRecovery,
                }),
              ),
            };
          if (p.action === 'discard-review') {
            await writer.forgetRecovery(p.id, principal);
            return { ok: true, directory: directorySnapshotPage(writer.getSnapshot()) };
          }
          if (p.action !== 'export-recovery') throw new Error('Unknown directory-save action');
          const { files, actor } = fileAccess();
          const originals = await writer.exportRecovery(p.id, principal);
          const blobs =
            p.format === 'zip'
              ? [{ path: 'Recovery.zip', blob: await createRecoveryZip(originals, { signal }) }]
              : originals;
          signal?.throwIfAborted();
          const transfer = await files.manager.createExport(actor, blobs, {
            workflow: 'project-directory-recovery',
            parameters: { id: p.id, format: p.format },
            expectedRevision: files.revision(),
          });
          return { ok: true, transfer: transferPage(transfer) };
        }
        case 'fusion_project_sources': {
          const p = schemas.fusion_project_sources.parse(a),
            sources = adapter.sources;
          if (!sources) throw new Error('Local project sources are unavailable in this client');
          if (!context)
            throw new Error(
              'Local project sources require a trusted browser or authenticated bridge context',
            );
          const principal = { owner: context.owner, scope: context.scope };
          if (p.action === 'retry-open' || p.action === 'discard-open') {
            if (!adapter.sourceOpen)
              throw new Error('Pending human project opens are unavailable in this client');
            if (p.action === 'retry-open')
              return { ok: true, ...(await adapter.sourceOpen.retry()) };
            adapter.sourceOpen.discard();
            return { ok: true, open: adapter.sourceOpen.status() };
          }
          if (p.action === 'retry') {
            await sources.retry();
            return { ok: true, sources: sources.getSnapshot(), open: adapter.sourceOpen?.status() };
          }
          if (p.action === 'status') {
            try {
              await sources.hydrate();
            } catch {
              /* Status exposes the bounded storage error. */
            }
            return { ok: true, sources: sources.getSnapshot(), open: adapter.sourceOpen?.status() };
          }
          await sources.hydrate();
          signal?.throwIfAborted();
          if (p.action === 'list')
            return { ok: true, listing: await sources.list(p.rootId, p.sort) };
          if (p.action === 'open') {
            const pending = adapter.sourceOpen?.status();
            if (pending?.busy || pending?.pending)
              throw new Error(
                'Resolve the pending human project open with retry-open or discard-open before starting another open',
              );
            const prepared = await sources.prepareOpen({
              sourceId: p.sourceId,
              target: p.target,
              expectedRevision: p.expectedRevision,
              requestId: p.requestId,
              principal,
            });
            signal?.throwIfAborted();
            return { ok: true, ...(await sources.commitOpen(prepared)) };
          }
          if (p.action === 'reference') {
            const record = await getProject(p.id);
            if (!record || record.trashed) throw new Error('Saved snapshot not found');
            return {
              ok: true,
              sourceId: await sources.rememberLibrary({
                id: record.id,
                label: record.name,
                modifiedAt: Date.parse(record.utc),
              }),
            };
          }
          if (p.action === 'select-root') await sources.selectRoot(p.rootId);
          if (p.action === 'forget-recent') await sources.forgetRecent(p.sourceId);
          if (p.action === 'clear-recent') await sources.clearRecent();
          if (p.action === 'forget-root') await sources.forgetRoot(p.rootId);
          if (p.action === 'flush') await sources.flush();
          return { ok: true, sources: sources.getSnapshot() };
        }
        case 'fusion_file_upload_begin': {
          const p = schemas.fusion_file_upload_begin.parse(a),
            { files, actor } = fileAccess();
          const revision = files.revision();
          if (p.expectedRevision !== undefined && p.expectedRevision !== revision)
            throw new Error('The requested design revision is stale');
          const transfer = await files.manager.beginUpload(actor, {
            files: p.files,
            binding: {
              workflow: p.operation.workflow,
              parameters: p.operation.parameters as TransferJson,
              expectedRevision: revision,
            },
          });
          return { ok: true, transfer: transferPage(transfer) };
        }
        case 'fusion_file_upload_chunk': {
          const p = schemas.fusion_file_upload_chunk.parse(a),
            { files, actor } = fileAccess();
          const transfer = await files.manager.putChunk(
            actor,
            p.id,
            p.fileIndex,
            p.chunkIndex,
            p.base64,
            p.sha256,
          );
          adapter.message(
            `File upload: ${transfer.files.reduce((n, f) => n + f.received.length, 0)}/${transfer.files.reduce((n, f) => n + f.chunks, 0)} chunks verified.`,
          );
          return { ok: true, transfer: transferPage(transfer) };
        }
        case 'fusion_file_upload_commit': {
          const p = schemas.fusion_file_upload_commit.parse(a),
            { files, actor } = fileAccess();
          const status = await files.manager.status(actor, p.id);
          if (status.state === 'uploading' || status.state === 'verifying')
            await files.manager.sealUpload(actor, p.id);
          const receipt = await adapter.operate('Importing verified files', () =>
            files.manager.commit(actor, p.id, {
              lookup: (id) => files.lookup(id, actor.owner),
              apply: async (binding, blobs, commitId) => {
                const operation = ImportWorkflowSchema.parse({
                  workflow: binding.workflow,
                  parameters: binding.parameters,
                });
                const prepared = await prepareFileImport(binding, blobs);
                signal?.throwIfAborted();
                const remember = prepared.remember
                  ? (documents: Record<Slot, Project>) => {
                      const source = prepared.slots.find(
                        (role) =>
                          operation.workflow !== 'calibration' ||
                          !!documents[role].presets[operation.parameters.preset - 1].channels[
                            operation.parameters.channel - 1
                          ].hfdMeasurement,
                      );
                      return source ? documents[source].hfdCalibration : undefined;
                    }
                  : undefined;
                return files.commit(
                  commitId,
                  { owner: actor.owner, scope: actor.scope },
                  binding.expectedRevision,
                  prepared.slots,
                  prepared.apply,
                  prepared.result,
                  remember,
                  { synchronizeLinks: prepared.synchronizeLinks },
                );
              },
            }),
          );
          adapter.message('File import receipt verified.');
          return { ok: true, receipt };
        }
        case 'fusion_file_export': {
          const p = schemas.fusion_file_export.parse(a),
            { files, actor } = fileAccess();
          const blobs = await prepareFileExport(
            p.operation,
            {
              documents: state.documents,
              ...(adapter.nativeProjectSave
                ? {
                    nativeSave: async (id: string, slot: Slot) => {
                      const staged = adapter
                        .nativeProjectSave!.status(actor)
                        .captures.find((entry) => entry.id === id);
                      if (!staged?.roles.some((entry) => entry.slot === slot))
                        throw new Error('That role is not part of this Save artifact');
                      const artifact = await adapter.nativeProjectSave!.resolve(id, actor),
                        role = artifact.roles.find((entry) => entry.slot === slot);
                      if (!role) throw new Error('That role is not part of this Save artifact');
                      return { project: role.project, files: role.files };
                    },
                  }
                : {}),
            },
            p.operation.workflow === 'workspace-recovery'
              ? (adapter.persistence?.recovery() ?? null)
              : null,
          );
          const transfer = await files.manager.createExport(actor, blobs, {
            workflow: p.operation.workflow,
            parameters: p.operation.parameters as TransferJson,
            expectedRevision: files.revision(),
          });
          return { ok: true, transfer: transferPage(transfer) };
        }
        case 'fusion_file_chunk_read': {
          const p = schemas.fusion_file_chunk_read.parse(a),
            { files, actor } = fileAccess();
          return {
            ok: true,
            ...(await files.manager.readChunk(actor, p.id, p.fileIndex, p.chunkIndex)),
          };
        }
        case 'fusion_file_status': {
          const p = schemas.fusion_file_status.parse(a),
            { files, actor } = fileAccess();
          const transfer = p.rebind
            ? await files.manager.rebind(actor, p.id)
            : await files.manager.status(actor, p.id);
          return { ok: true, transfer: transferPage(transfer, p.fileOffset, p.limit) };
        }
        case 'fusion_file_list': {
          const p = schemas.fusion_file_list.parse(a),
            { files, actor } = fileAccess();
          const transfers = await files.manager.list(actor, {
            includeOtherScopes: p.includeOtherScopes,
          });
          return {
            ok: true,
            total: transfers.length,
            offset: p.offset,
            nextOffset: p.offset + p.limit < transfers.length ? p.offset + p.limit : null,
            transfers: transfers.slice(p.offset, p.offset + p.limit).map((transfer) => ({
              id: transfer.id,
              direction: transfer.direction,
              state: transfer.state,
              rebindRequired: transfer.rebindRequired,
              totalBytes: transfer.totalBytes,
              fileCount: transfer.files.length,
              createdAt: transfer.createdAt,
              expiresAt: transfer.expiresAt,
              idleExpiresAt: transfer.idleExpiresAt,
              workflow: transfer.binding?.workflow,
              expectedRevision: transfer.binding?.expectedRevision,
              filesPreview: transfer.files
                .slice(0, 3)
                .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
              hasReceipt: transfer.receipt !== undefined,
            })),
          };
        }
        case 'fusion_file_close': {
          const p = schemas.fusion_file_close.parse(a),
            { files, actor } = fileAccess();
          return { ok: true, ...(await files.manager.close(actor, p.id)) };
        }
        case 'fusion_eq_default': {
          const p = schemas.fusion_eq_default.parse(a);
          adapter.edit(roles(p.target), (doc) => resetInputEq(doc, p.preset - 1));
          adapter.message('Default EQ staged. Q and whole-EQ bypass retained.');
          return { ok: true };
        }
        case 'fusion_eq_copy_all': {
          const p = schemas.fusion_eq_copy_all.parse(a);
          adapter.edit(roles(p.target), (doc) =>
            copyInputEqToPresets(doc, p.preset - 1, [0, 1, 2]),
          );
          adapter.message(
            'Nine EQ bands copied to all design presets. Upload explicitly to program an amp.',
          );
          return { ok: true };
        }
        case 'fusion_eq_save_all': {
          const p = schemas.fusion_eq_save_all.parse(a),
            slots = roles(p.target);
          await adapter.operate('Agent: saving EQ to all presets', () =>
            uploadEqBankPair(
              slots.map((s) => ({
                session: get(s).session,
                label: s,
                bank: state.documents[s].presets.map((pr) => ({
                  bands: structuredClone(state.documents[s].presets[p.preset - 1].inputEq),
                  enabled: pr.eqEnabled,
                })),
                preserveActivation: true,
                progress: (n, m) => adapter.progress(s, n, m),
              })),
            ),
          );
          await adapter.refresh(slots);
          adapter.message(
            'EQ saved to all three amp presets and verified; live bypass flags and active preset retained. Outputs muted.',
          );
          return { ok: true };
        }
        case 'fusion_eq_bank': {
          const p = schemas.fusion_eq_bank.parse(a),
            clipboard = adapter.eqClipboard,
            source = p.source ?? state.slot,
            slots = roles(p.target ?? state.slot);
          if (!clipboard) throw new Error('The temporary EQ bank is unavailable in this client');
          if (p.action === 'inspect')
            return { ok: true, bank: clipboard.get() ?? null, label: clipboard.label() };
          if (p.action === 'clear') {
            clipboard.clear();
            adapter.message('Copied EQ bank cleared.');
            return { ok: true };
          }
          if (p.action === 'copy-design') {
            clipboard.set(
              snapshotEqBank(state.documents[source]),
              `${source} design · three presets`,
            );
          } else if (p.action === 'copy-device') {
            const bank = await adapter.operate('Agent: copying three physical EQ sets', () =>
              readEqBank(get(source).session),
            );
            clipboard.set(bank, `${source} amp · three presets`);
          } else {
            const bank = clipboard.get();
            if (!bank) throw new Error('Copy an EQ bank first');
            if (p.action === 'apply-design') adapter.edit(slots, (doc) => applyEqBank(doc, bank));
            else {
              await adapter.operate('Agent: writing copied EQ bank', () =>
                uploadEqBankPair(
                  slots.map((s) => ({
                    session: get(s).session,
                    bank,
                    label: s,
                    progress: (n, m) => adapter.progress(s, n, m),
                  })),
                ),
              );
              await adapter.refresh(slots);
            }
          }
          adapter.message(
            p.action === 'write-device'
              ? 'Copied EQ bank verified on selected amps; outputs remain muted.'
              : p.action === 'apply-design'
                ? 'Copied EQ bank applied to selected designs.'
                : 'Three EQ presets copied into this tab’s temporary bank.',
          );
          return { ok: true, present: !!clipboard.get(), label: clipboard.label() };
        }
        case 'fusion_eq_set': {
          const p = schemas.fusion_eq_set.parse(a);
          const changed = roles(p.target).filter((role) => {
            const pr = state.documents[role].presets[p.preset - 1],
              f = pr.inputEq[p.index - 1];
            const next = editInputEqBand(f, p.patch, { redesign: p.redesign });
            encodeEq(pr.inputEq.map((band, index) => (index === p.index - 1 ? next : band)));
            return (
              JSON.stringify(f) !== JSON.stringify(next) ||
              (p.enabled !== undefined && p.enabled !== pr.eqEnabled)
            );
          });
          if (changed.length)
            adapter.edit(changed, (doc) => {
              const pr = doc.presets[p.preset - 1];
              pr.inputEq[p.index - 1] = editInputEqBand(pr.inputEq[p.index - 1], p.patch, {
                redesign: p.redesign,
              });
              if (p.enabled !== undefined) pr.eqEnabled = p.enabled;
            });
          break;
        }
        case 'fusion_eq_adjust': {
          const p = schemas.fusion_eq_adjust.parse(a),
            selected = roles(p.target);
          if (p.basis !== 'each' && !selected.includes(p.basis))
            throw new Error('EQ wheel source must be a selected role');
          const fields = selected.map((slot) => {
            const pr = state.documents[slot].presets[p.preset - 1];
            if (pr.inputEq.length !== 9) throw new Error('Input EQ requires nine bands');
            const filter = pr.inputEq[p.index - 1];
            return { slot, filter, preset: pr };
          });
          const compute = (field: (typeof fields)[number]) =>
            hfdInputEqWheelNext(
              p.parameter,
              field.filter[p.parameter],
              p.direction === 'up' ? 1 : -1,
            );
          const source =
            p.basis === 'each'
              ? undefined
              : compute(fields.find((field) => field.slot === p.basis)!);
          const plan = fields.map((field) => {
            const result = source ?? compute(field),
              before = field.filter[p.parameter];
            const changed = result.changed && !Object.is(result.value, before);
            const next = changed
              ? editInputEqBand(field.filter, { [p.parameter]: result.value }, { normalize: false })
              : field.filter;
            encodeEq(
              field.preset.inputEq.map((band, index) => (index === p.index - 1 ? next : band)),
            );
            return {
              slot: field.slot,
              before,
              value: changed ? result.value : before,
              text: changed ? result.text : formatHfdInputEqValue(p.parameter, before),
              changed,
              beforeFilter: structuredClone(field.filter),
            };
          });
          const changed = plan.filter((role) => role.changed);
          if (changed.length)
            adapter.edit(
              changed.map((role) => role.slot),
              (doc) => {
                const pr = doc.presets[p.preset - 1],
                  filter = pr.inputEq[p.index - 1];
                const matches = changed.filter(
                  (role) => JSON.stringify(role.beforeFilter) === JSON.stringify(filter),
                );
                const role = matches[0];
                if (!role || matches.some((match) => !Object.is(match.value, role.value)))
                  throw new Error('The EQ wheel target changed');
                pr.inputEq[p.index - 1] = editInputEqBand(
                  filter,
                  { [p.parameter]: role.value },
                  { normalize: false },
                );
              },
            );
          return {
            ok: true,
            changed: changed.length > 0,
            basis: p.basis,
            roles: plan.map(({ beforeFilter: _beforeFilter, ...role }) => role),
          };
        }
        case 'fusion_fir_set': {
          const p = schemas.fusion_fir_set.parse(a);
          if (p.native) {
            adapter.edit(
              roles(p.target),
              (doc) => applyNativeFirAction(doc.presets[p.preset - 1], p.native!),
              { synchronizeLinks: false },
            );
            break;
          }
          const taps =
            p.text === undefined ? undefined : parseFir(p.text, p.channel === 0 ? 4500 : 1500);
          adapter.edit(roles(p.target), (doc) => {
            editPresetFir(doc.presets[p.preset - 1], p.channel!, {
              name: p.name!,
              ...(taps === undefined ? {} : { taps }),
              ...(p.enabled === undefined ? {} : { enabled: p.enabled }),
              clear: p.clear,
            });
          });
          break;
        }
        case 'fusion_measurement_set': {
          const p = schemas.fusion_measurement_set.parse(a),
            measurement =
              p.text === null
                ? undefined
                : p.format === 'impulse'
                  ? parseImpulse(p.text, p.name, p.sampleRate)
                  : parseMeasurement(p.text, p.name);
          if (measurement?.impulse && measurement.sampleRate !== p.sampleRate)
            Object.assign(measurement, spectrum(measurement.impulse, p.sampleRate));
          adapter.edit(roles(p.target), (doc) => {
            const channel = doc.presets[p.preset - 1].channels[p.channel - 1];
            if (p.text === null) {
              if (channel.hfdMeasurement)
                clearHfdCapture(channel, channel.hfdMeasurement.sampleRate);
              else delete channel.measurement;
            } else importChannelMeasurement(channel, measurement, p.analysis);
          });
          adapter.measurementsReplaced?.(roles(p.target), p.preset - 1, [p.channel - 1]);
          break;
        }
        case 'fusion_analyze': {
          const p = schemas.fusion_analyze.parse(a),
            pr = state.documents[p.slot].presets[p.preset - 1],
            electricalView = prepareNativeElectricalView(pr.channels, pr),
            view = buildHfdResponseView(pr.channels, {
              preset: pr,
              measured: p.measured,
              sum: true,
              centered: p.nativeCentered,
              referenceChannel: p.referenceChannel - 1,
              showUnloadedFilters: p.showUnloadedFilters,
            }),
            layerView = p.layers
              ? buildMagnitudeLayers(pr.channels, {
                  preset: pr,
                  layers: p.layers,
                  referenceChannel: p.referenceChannel - 1,
                  selectedFilter:
                    p.layers.selectedFilter == null ? null : p.layers.selectedFilter - 1,
                  sum: p.layers.sum,
                  measured: p.measured,
                  centered: p.nativeCentered,
                  showUnloadedFilters: p.showUnloadedFilters,
                })
              : undefined;
          return {
            ok: true,
            ...(layerView
              ? {
                  magnitudeLayers: {
                    availability: layerView.availability,
                    centered: layerView.centered,
                    centerOffsetDb: layerView.centerOffsetDb,
                    warnings: layerView.warnings,
                    curves: layerView.curves.map(({ db, ...curve }) => ({
                      ...curve,
                      ...(curve.channel === undefined ? {} : { channel: curve.channel + 1 }),
                      ...(curve.filter === undefined ? {} : { filter: curve.filter + 1 }),
                      points: p.frequencies.map((frequency) => ({
                        frequency,
                        db: sampleHfdView(layerView, db, frequency),
                      })),
                    })),
                  },
                }
              : {}),
            nativeView: view
              ? {
                  centered: view.centered,
                  centerOffsetDb: view.centerOffsetDb,
                  warnings: view.warnings,
                }
              : null,
            sampleRate: FS,
            points: p.frequencies.map((frequency) => {
              const channels = pr.channels.map((c, index) => {
                  const [real, imaginary] = presetResponse(
                      pr,
                      pr.channels.indexOf(c),
                      frequency,
                      p.measured,
                    ),
                    [viewReal, viewImaginary] = electricalView.evaluate(
                      index,
                      frequency,
                      p.measured,
                    );
                  return {
                    real,
                    imaginary,
                    db: 20 * Math.log10(Math.max(1e-12, Math.hypot(real, imaginary))),
                    phaseDegrees: (Math.atan2(imaginary, real) * 180) / Math.PI,
                    viewDb: view
                      ? view.channels[index].visible === false
                        ? null
                        : sampleHfdView(view, view.channels[index].db, frequency)
                      : 20 * Math.log10(Math.max(1e-12, Math.hypot(viewReal, viewImaginary))),
                    viewPhaseDegrees: view
                      ? view.channels[index].visible === false
                        ? null
                        : sampleHfdView(view, view.channels[index].phase, frequency)
                      : (Math.atan2(viewImaginary, viewReal) * 180) / Math.PI,
                  };
                }),
                re = channels.reduce(
                  (s, c, i) =>
                    s +
                    (pr.channels[i].includeInSum === false ||
                    (p.measured && !pr.channels[i].measurement?.frequency?.length)
                      ? 0
                      : c.real),
                  0,
                ),
                im = channels.reduce(
                  (s, c, i) =>
                    s +
                    (pr.channels[i].includeInSum === false ||
                    (p.measured && !pr.channels[i].measurement?.frequency?.length)
                      ? 0
                      : c.imaginary),
                  0,
                ),
                displaySum = pr.channels.reduce<[number, number]>(
                  (value, channel, index) => {
                    if (
                      channel.includeInSum === false ||
                      (p.measured && !channel.measurement?.frequency?.length)
                    )
                      return value;
                    const [real, imaginary] = electricalView.evaluate(index, frequency, p.measured);
                    return [value[0] + real, value[1] + imaginary];
                  },
                  [0, 0],
                );
              return {
                frequency,
                channels,
                sumReal: re,
                sumImaginary: im,
                sumDb: 20 * Math.log10(Math.max(1e-12, Math.hypot(re, im))),
                sumPhaseDegrees: (Math.atan2(im, re) * 180) / Math.PI,
                viewSumDb: view?.sum
                  ? sampleHfdView(view, view.sum.db, frequency)
                  : 20 * Math.log10(Math.max(1e-12, Math.hypot(...displaySum))),
                viewSumPhaseDegrees: view?.sum
                  ? sampleHfdView(view, view.sum.phase, frequency)
                  : (Math.atan2(displaySum[1], displaySum[0]) * 180) / Math.PI,
              };
            }),
          };
        }
        case 'fusion_hfd_measurement': {
          const p = schemas.fusion_hfd_measurement.parse(a);
          if (p.action === 'audio') return execute('fusion_audio', p.audio, execution);
          if (p.action === 'inspect')
            return {
              ok: true,
              presets: roles(p.target!).map((slot) => {
                const project = state.documents[slot];
                return {
                  slot,
                  channels: project.presets[p.preset! - 1].channels.map((channel) =>
                    hfdMeasurementStatus(channel, project.hfdCalibration),
                  ),
                };
              }),
            };
          if (p.action === 'share' && p.sourceChannel === undefined)
            throw new Error('Choose a source channel or null to stop sharing');
          if (p.action === 'options' && !p.patch) throw new Error('Supply an options patch');
          adapter.edit(roles(p.target!), (doc) => {
            const pr = doc.presets[p.preset! - 1],
              c = pr.channels[p.channel - 1];
            if (p.action === 'enable-preset') enablePresetHfdMeasurement(pr);
            else if (p.action === 'share')
              setSharedHfdCrop(pr, p.sourceChannel === null ? null : p.sourceChannel! - 1);
            else if (p.action === 'enable') useHfdNative(c, p.patch);
            else if (p.action === 'browser') useBrowserMeasurement(c);
            else updateHfdMeasurement(c, p.patch!);
          });
          return { ok: true };
        }
        case 'fusion_microphone': {
          const p = schemas.fusion_microphone.parse(a),
            slots = roles(p.target),
            summary = (slot: Slot) => {
              const project = adapter.state().documents[slot],
                status = projectMicrophoneStatus(project);
              return {
                slot,
                ...status,
                applyFlags: project.presets.map((pr) =>
                  pr.channels.map((c) => c.hfdMeasurement?.applyMicCorrection ?? false),
                ),
                warnings: [
                  ...new Set([
                    ...status.warnings,
                    ...project.presets.flatMap((pr) =>
                      pr.channels.flatMap(
                        (c) => hfdMeasurementStatus(c, project.hfdCalibration).warnings,
                      ),
                    ),
                  ]),
                ],
              };
            };
          if (p.action === 'inspect') return { ok: true, projects: slots.map(summary) };
          if (p.action === 'load' && (p.content === undefined || p.name === undefined))
            throw new Error('Supply microphone file content and name');
          if (
            p.action === 'options' &&
            p.showCurve === undefined &&
            p.smoothingOctaves === undefined
          )
            throw new Error('Supply a microphone option');
          adapter.edit(slots, (project) => {
            if (p.action === 'load') loadProjectMicrophone(project, p.content!, p.name!);
            else if (p.action === 'unload') unloadProjectMicrophone(project);
            if (p.showCurve !== undefined || p.smoothingOctaves !== undefined)
              setProjectMicrophoneOptions(project, {
                ...(p.showCurve === undefined ? {} : { showCurve: p.showCurve }),
                ...(p.smoothingOctaves === undefined
                  ? {}
                  : { smoothingOctaves: p.smoothingOctaves }),
              });
          });
          if (p.action === 'load' || p.action === 'unload')
            adapter.microphone?.remember(
              p.action === 'unload'
                ? undefined
                : structuredClone(adapter.state().documents[slots[0]].hfdCalibration),
            );
          return { ok: true, projects: slots.map(summary) };
        }
        case 'fusion_time_analyze': {
          const p = schemas.fusion_time_analyze.parse(a),
            pr = state.documents[p.slot].presets[p.preset - 1],
            eq = p.scope === 'input-eq',
            channels = eq ? [inputEqAnalysisChannel(pr)] : pr.channels,
            analysis = analyzeTimeResponses(channels, {
              preset: eq ? undefined : pr,
              measured: !eq && p.measured,
              sum: !eq && p.sum,
              referenceChannel: eq ? 0 : p.referenceChannel - 1,
            }),
            curves = [...analysis.channels, ...(analysis.sum ? [analysis.sum] : [])],
            series = curves.flatMap((c) =>
              c[p.mode === 'Step' ? 'step' : 'impulse']
                ? [c[p.mode === 'Step' ? 'step' : 'impulse']!]
                : [],
            ),
            fit = fitTimeSeries(series),
            range = {
              ...fit,
              timeMinMs: p.timeMinMs ?? fit.timeMinMs,
              timeMaxMs: p.timeMaxMs ?? fit.timeMaxMs,
            };
          if (range.timeMinMs >= range.timeMaxMs)
            throw new Error('Time minimum must be below maximum');
          const describe = (c: (typeof curves)[number]) => {
            const data = p.mode === 'Step' ? c.step : c.impulse;
            if (!data)
              return { source: c.source, reason: c.reason, warnings: c.warnings, points: [] };
            let peakIndex = 0;
            for (let i = 1; i < data.samples.length; i++)
              if (Math.abs(data.samples[i]) > Math.abs(data.samples[peakIndex])) peakIndex = i;
            return {
              source: c.source,
              warnings: c.warnings,
              sampleRate: data.sampleRate,
              startTimeMs: data.startTimeMs,
              sampleCount: data.samples.length,
              peak: {
                timeMs: data.startTimeMs + (peakIndex * 1000) / data.sampleRate,
                value: data.samples[peakIndex] ?? 0,
              },
              points: plotTimeSeries(data, range, p.points),
            };
          };
          return {
            ok: true,
            mode: p.mode,
            scope: p.scope,
            range,
            windowBounds: analysis.windowBounds,
            channels: analysis.channels.map(describe),
            ...(analysis.sum ? { sum: describe(analysis.sum) } : {}),
            warnings: analysis.warnings,
          };
        }
        case 'fusion_compile': {
          const p = schemas.fusion_compile.parse(a);
          return {
            ok: true,
            channels: state.documents[p.slot].presets[p.preset - 1].channels.map((c) =>
              hex(encodeChannel(c)),
            ),
          };
        }
        case 'fusion_help': {
          const p = schemas.fusion_help.parse(a);
          if (p.action === 'show') {
            const tab = p.view === 'verification' ? 'Verification' : 'Help';
            adapter.view({ tab });
            return { ok: true, view: tab, resources: getHelpResources() };
          }
          return { ok: true, resources: getHelpResources() };
        }
        case 'fusion_view':
          adapter.view(schemas.fusion_view.parse(a));
          break;
        case 'fusion_devices': {
          const p = schemas.fusion_devices.parse(a);
          const devices = adapter.amplifiers;
          if (!devices) throw new Error('Amplifier discovery is unavailable in this client');
          if (!context)
            throw new Error('Amplifier discovery requires a trusted application context');
          parseExecutionPrincipal({ owner: context.owner, scope: context.scope });
          if (p.action === 'read') {
            if (!adapter.readAmplifierProject)
              throw new Error('Reading a complete amplifier design is unavailable');
            return { ok: true, result: await adapter.readAmplifierProject(p.slot) };
          }
          if ('expectedRevision' in p && devices.getSnapshot().revision !== p.expectedRevision)
            throw new Error('Amplifier connections changed; review the current assignments');
          if (p.action === 'discover') await devices.discover();
          if (p.action === 'assign') await devices.assign(p.id, p.slot, p.expectedRevision);
          if (p.action === 'swap') devices.swap(p.expectedRevision);
          if (p.action === 'disconnect') await devices.disconnect(p.slot, p.expectedRevision);
          if (p.action === 'auto-connect') devices.setAutoReconnect(p.enabled);
          return { ok: true, devices: devices.getSnapshot() };
        }
        case 'fusion_connect': {
          const p = schemas.fusion_connect.parse(a);
          await adapter.connect(p.slot, p.serial);
          break;
        }
        case 'fusion_disconnect': {
          const p = schemas.fusion_disconnect.parse(a);
          await adapter.operate('Disconnecting amplifiers', () =>
            Promise.all(roles(p.target).map(adapter.disconnect)),
          );
          break;
        }
        case 'fusion_controls': {
          const p = schemas.fusion_controls.parse(a);
          await adapter.operate('Agent: updating controls', async () => {
            const slots = roles(p.target),
              preparedPatches = new Map<Slot, Controls>();
            // Permission/capability/range refusal is read-only and occurs
            // outside the post-write pair-mute recovery path for every patch.
            await preflightTargets(slots, async (s) => {
              const session = get(s).session,
                patch = { ...p.patch };
              if (p.relativeVolume && patch.volume !== undefined)
                patch.volume = (await session.status()).volume + patch.volume;
              await session.preflightControls(patch);
              preparedPatches.set(s, patch);
            });
            const result = await Promise.allSettled(
              slots.map(async (s) => {
                const l = get(s),
                  patch = preparedPatches.get(s) ?? { ...p.patch };
                if (!preparedPatches.has(s) && p.relativeVolume && patch.volume !== undefined)
                  patch.volume = (await l.session.status()).volume + patch.volume;
                await l.session.setControls(patch);
              }),
            );
            if (result.some((r) => r.status === 'rejected')) {
              // An uncertain one-output mute does not authorize a second,
              // amplifier-wide setter or an automatic retry.
              if (!p.patch.outputMute)
                await Promise.allSettled(
                  slots.map((s) => get(s).session.setControls({ mute: true })),
                );
              throw new Error(
                result
                  .filter((r) => r.status === 'rejected')
                  .map((r) => String(r.reason))
                  .join('; '),
              );
            }
            await adapter.refresh(slots);
          });
          break;
        }
        case 'fusion_read_preset': {
          const p = schemas.fusion_read_preset.parse(a);
          await adapter.operate('Agent: reading preset', async () => {
            const l = get(p.slot),
              r = await l.session.readPreset(p.preset);
            adapter.edit([p.slot], (doc) => {
              doc.presets[p.preset - 1].channels = r.channels;
              doc.name = l.identity.name;
            });
          });
          break;
        }
        case 'fusion_backup': {
          const p = schemas.fusion_backup.parse(a);
          return await adapter.operate('Agent: backup', async () => ({
            ok: true,
            backups: await Promise.all(roles(p.target).map((s) => get(s).session.backup(p.preset))),
          }));
        }
        case 'fusion_backups_list': {
          const p = schemas.fusion_backups_list.parse(a);
          return {
            ok: true,
            backups: (await listBackups())
              .filter((b) => !p.serial || b.serial === p.serial)
              .map(({ sector_hex, ...b }) => b),
          };
        }
        case 'fusion_backup_import': {
          const p = schemas.fusion_backup_import.parse(a);
          return await adapter.operate('Agent: importing recovery file', async () => {
            const backup = await importBackupFile(p.content);
            return {
              ok: true,
              backupId: backup.id,
              serial: backup.serial,
              preset: backup.preset,
              address: backup.address,
              sha256: backup.sha256,
            };
          });
        }
        case 'fusion_restore': {
          const p = schemas.fusion_restore.parse(a),
            b = (await listBackups()).find((b) => b.id === p.backupId);
          if (!b) throw new Error('Backup not found');
          await adapter.operate('Agent: restoring backup', () =>
            get(p.slot).session.restore(b, (n, m) => adapter.progress(p.slot, n, m)),
          );
          await adapter.refresh([p.slot]);
          break;
        }
        case 'fusion_upload': {
          const p = schemas.fusion_upload.parse(a),
            slots = roles(p.target),
            fir = firUploadScope(slots, [p.preset]);
          await adapter.operate('Agent: uploading', () =>
            uploadPair(
              slots.map((s) => ({
                session: get(s).session,
                preset: p.preset,
                name: state.documents[s].name,
                design: state.documents[s].presets[p.preset - 1],
                progress: (n, m) => adapter.progress(s, n, m),
              })),
            ),
          );
          await adapter.refresh(slots);
          return { ok: true, fir };
        }
        case 'fusion_upload_all': {
          const p = schemas.fusion_upload_all.parse(a),
            slots = roles(p.target),
            fir = firUploadScope(slots, [1, 2, 3]);
          await adapter.operate('Agent: uploading all crossover presets', () =>
            uploadProjectPair(
              slots.map((slot) => ({
                session: get(slot).session,
                name: state.documents[slot].name,
                presets: state.documents[slot].presets,
                label: slot,
                progress: (n, m) => adapter.progress(slot, n, m),
              })),
            ),
          );
          await adapter.refresh(slots);
          return {
            ok: true,
            presets: [1, 2, 3],
            muted: true,
            startingActivePresetsRestored: true,
            fir,
          };
        }
        case 'fusion_eq_read': {
          const p = schemas.fusion_eq_read.parse(a);
          await adapter.operate('Agent: reading input EQ', async () => {
            const r = await get(p.slot).session.readEq(p.preset);
            const status = await get(p.slot).session.status();
            adapter.edit([p.slot], (d) => {
              const pr = d.presets[p.preset - 1];
              pr.inputEq = r.bands.map((f, i) => ({
                ...f,
                id: pr.inputEq[i].id,
                sourceId: pr.inputEq[i].sourceId,
              }));
              pr.eqEnabled = !!(status.raw[11 + p.preset] & 16);
            });
          });
          break;
        }
        case 'fusion_eq_upload': {
          const p = schemas.fusion_eq_upload.parse(a),
            slots = roles(p.target);
          await adapter.operate('Agent: uploading input EQ', () =>
            uploadEqPair(
              slots.map((s) => {
                const pr = state.documents[s].presets[p.preset - 1];
                return {
                  session: get(s).session,
                  label: s,
                  preset: p.preset,
                  bands: pr.inputEq,
                  enabled: pr.eqEnabled,
                  progress: (n, m) => adapter.progress(s, n, m),
                };
              }),
            ),
          );
          await adapter.refresh(slots);
          break;
        }
        case 'fusion_fir_read': {
          const p = schemas.fusion_fir_read.parse(a);
          await adapter.operate('Agent: reading FIR', async () => {
            const r = await readFir(get(p.slot).session, p.preset);
            const latest = adapter.state();
            if (
              latest.documents[p.slot] !== state.documents[p.slot] ||
              latest.documentRevision !== state.documentRevision
            )
              throw new Error(
                'The design changed while reading FIR; read again to apply to the current design',
              );
            adapter.edit([p.slot], (d) => applyReadFir(d.presets[p.preset - 1], r), {
              synchronizeLinks: false,
            });
          });
          break;
        }
        case 'fusion_fir_upload': {
          const p = schemas.fusion_fir_upload.parse(a),
            slots = roles(p.target),
            fir = firUploadScope(slots, [p.preset]);
          await adapter.operate('Agent: uploading FIR', () =>
            uploadFirPair(
              slots.map((s) => ({
                session: get(s).session,
                preset: p.preset,
                design: state.documents[s].presets[p.preset - 1],
                progress: (n, m) => adapter.progress(s, n, m),
              })),
            ),
          );
          await adapter.refresh(slots);
          return { ok: true, fir };
        }
        case 'fusion_fir_backups': {
          const p = schemas.fusion_fir_backups.parse(a);
          return {
            ok: true,
            backups: (await listFirBackups())
              .filter((b) => !p.serial || b.serial === p.serial)
              .map(({ sectors, filenames, ...b }) => b),
          };
        }
        case 'fusion_fir_restore': {
          const p = schemas.fusion_fir_restore.parse(a),
            backup = (await listFirBackups()).find((b) => b.id === p.backupId);
          if (!backup) throw new Error('FIR backup not found');
          await adapter.operate('Agent: restoring FIR', () =>
            restoreFir(get(p.slot).session, backup, (n, m) => adapter.progress(p.slot, n, m)),
          );
          await adapter.refresh([p.slot]);
          break;
        }
        case 'fusion_fir_placement': {
          const p = schemas.fusion_fir_placement.parse(a);
          adapter.edit(
            roles(p.target),
            (d) => selectNativeFirPlacement(d.presets[p.preset - 1], p.placement),
            { synchronizeLinks: false },
          );
          break;
        }
        case 'fusion_measurement_import_wav': {
          const p = schemas.fusion_measurement_import_wav.parse(a),
            bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0)),
            measurement = decodeWav(bytes.buffer, p.name);
          adapter.edit(roles(p.target), (d) => {
            importChannelMeasurement(
              d.presets[p.preset - 1].channels[p.channel - 1],
              measurement,
              p.analysis,
            );
          });
          adapter.measurementsReplaced?.(roles(p.target), p.preset - 1, [p.channel - 1]);
          break;
        }
        case 'fusion_measurement_window': {
          const p = schemas.fusion_measurement_window.parse(a);
          adapter.edit(roles(p.target), (d) => {
            const c = d.presets[p.preset - 1].channels[p.channel - 1],
              m = c.measurement;
            if (!m?.impulse) throw new Error('Load an impulse response first');
            processChannelMeasurement(c, {
              window: { start: p.start, end: p.end, taper: p.taper, timeZero: p.timeZero },
            });
          });
          break;
        }
        case 'fusion_measurement_smooth': {
          const p = schemas.fusion_measurement_smooth.parse(a);
          adapter.edit(roles(p.target), (d) => {
            const c = d.presets[p.preset - 1].channels[p.channel - 1];
            if (!c.measurement) throw new Error('No measurement loaded');
            processChannelMeasurement(c, { smoothingOctaves: p.octaves });
          });
          break;
        }
        case 'fusion_measurement_calibrate': {
          const p = schemas.fusion_measurement_calibrate.parse(a),
            slots = roles(p.target),
            nativeSlots = slots.filter(
              (slot) =>
                state.documents[slot].presets[p.preset - 1].channels[p.channel - 1].hfdMeasurement,
            );
          let cal: ReturnType<typeof parseMeasurement> | undefined;
          adapter.edit(roles(p.target), (d) => {
            const c = d.presets[p.preset - 1].channels[p.channel - 1];
            if (!c.measurement) throw new Error('No measurement loaded');
            if (c.hfdMeasurement) {
              loadProjectMicrophone(d, p.content, p.name);
              // Loading clones/replaces the preset array; reacquire the target.
              d.presets[p.preset - 1].channels[p.channel - 1].hfdMeasurement!.applyMicCorrection =
                true;
              reconcileProjectHfdCalibration(d);
              return;
            }
            cal ??= parseMeasurement(p.content, p.name);
            if (!cal.frequency?.length || !cal.magnitude?.length)
              throw new Error('Load a frequency/dB correction file');
            processChannelMeasurement(c, {
              calibration: {
                name: cal.name,
                sampleRate: cal.sampleRate,
                frequency: cal.frequency,
                magnitude: cal.magnitude,
                phase: cal.phase,
              },
              calibrationEnabled: true,
            });
          });
          if (nativeSlots.length)
            adapter.microphone?.remember(
              structuredClone(adapter.state().documents[nativeSlots[0]].hfdCalibration),
            );
          break;
        }
        case 'fusion_measurement_processing': {
          const p = schemas.fusion_measurement_processing.parse(a);
          if (p.audio !== undefined) return execute('fusion_audio', p.audio, execution);
          if (p.truncateToView) {
            const view = z
              .object({
                tab: z.literal('Crossover'),
                mode: z.enum(['Impulse', 'Step']),
                measured: z.literal(true),
                timeMinMs: finite,
                timeMaxMs: finite,
              })
              .passthrough()
              .safeParse(adapter.viewState?.());
            if (!view.success)
              throw new Error(
                'Show a measured Crossover Impulse or Step view before native Truncate',
              );
            const range = { timeMinMs: view.data.timeMinMs, timeMaxMs: view.data.timeMaxMs },
              slots = roles(p.target);
            adapter.edit(slots, (project) =>
              truncateHfdVisibleRange(project, p.preset - 1, p.channel - 1, range),
            );
            const updated = adapter.state();
            return {
              ok: true,
              range,
              destinations: slots.map((slot) => {
                const channel =
                  updated.documents[slot].presets[p.preset - 1].channels[p.channel - 1];
                return {
                  slot,
                  preset: p.preset,
                  channel: p.channel,
                  options: { ...channel.hfdMeasurement! },
                };
              }),
            };
          }
          if (p.clearCalibration && p.calibrationEnabled)
            throw new Error('Cannot unload and enable correction in one command');
          adapter.edit(roles(p.target), (doc) => {
            const c = doc.presets[p.preset - 1].channels[p.channel - 1];
            let m = c.measurement;
            if (!m) throw new Error('No measurement loaded');
            if (c.hfdMeasurement) {
              if (p.reset)
                processChannelMeasurement(c, {
                  window: null,
                  smoothingOctaves: 0,
                  calibration: null,
                });
              if (p.sampleRate !== undefined) updateHfdMeasurement(c, { sampleRate: p.sampleRate });
              if (p.resetWindow) processChannelMeasurement(c, { window: null });
              const resourcePatch: Parameters<typeof processChannelMeasurement>[1] = {};
              if (doc.hfdCalibration) {
                if (p.clearCalibration) {
                  if (c.measurement?.processing?.calibration) resourcePatch.calibration = null;
                  updateHfdMeasurement(c, { applyMicCorrection: false });
                }
                if (p.calibrationEnabled !== undefined)
                  updateHfdMeasurement(c, { applyMicCorrection: p.calibrationEnabled });
              } else {
                if (p.clearCalibration) resourcePatch.calibration = null;
                if (p.calibrationEnabled !== undefined)
                  resourcePatch.calibrationEnabled = p.calibrationEnabled;
              }
              if (Object.keys(resourcePatch).length) processChannelMeasurement(c, resourcePatch);
              if (p.peakZero) {
                if (!m.impulse?.length) throw new Error('Load an impulse first');
                let peak = 0;
                for (let i = 1; i < m.impulse.length; i++)
                  if (Math.abs(m.impulse[i]) > Math.abs(m.impulse[peak])) peak = i;
                updateHfdMeasurement(c, { phaseStart: peak });
              }
              if (doc.hfdCalibration) reconcileProjectHfdCalibration(doc);
              return;
            }
            if (p.reset) m = resetMeasurementProcessing(m);
            const patch: Parameters<typeof processMeasurement>[1] = {};
            if (p.sampleRate !== undefined) {
              m = { ...m, sampleRate: p.sampleRate };
              if (m.impulse)
                patch.window = m.processing?.window ?? {
                  start: 0,
                  end: m.impulse.length,
                  taper: 0,
                  timeZero: 0,
                };
            }
            if (p.resetWindow) patch.window = null;
            if (p.clearCalibration) patch.calibration = null;
            if (p.calibrationEnabled !== undefined) patch.calibrationEnabled = p.calibrationEnabled;
            if (p.peakZero) {
              if (!m.impulse?.length) throw new Error('Load an impulse first');
              let peak = 0;
              for (let i = 1; i < m.impulse.length; i++)
                if (Math.abs(m.impulse[i]) > Math.abs(m.impulse[peak])) peak = i;
              patch.window = {
                ...(!p.resetWindow && m.processing?.window
                  ? m.processing.window
                  : { start: 0, end: m.impulse.length, taper: 0, timeZero: 0 }),
                timeZero: peak,
              };
            }
            c.measurement = Object.keys(patch).length ? processMeasurement(m, patch) : m;
          });
          break;
        }
        case 'fusion_measurement_export': {
          const p = schemas.fusion_measurement_export.parse(a),
            m = state.documents[p.slot].presets[p.preset - 1].channels[p.channel - 1].measurement;
          if (!m) throw new Error('No measurement loaded');
          if (p.format === 'impulse' && !m.impulse) throw new Error('No impulse samples available');
          return {
            ok: true,
            content:
              p.format === 'impulse'
                ? m.impulse!.join('\n')
                : m.frequency
                    ?.map((f, i) => [f, m.magnitude?.[i] ?? 0, m.phase?.[i] ?? 0].join('\t'))
                    .join('\n'),
          };
        }
        case 'fusion_noise': {
          const p = schemas.fusion_noise.parse(a),
            controller = adapter.noise;
          if (!controller) throw new Error('Rotating-noise control is unavailable in this client');
          controller.refreshBindings();
          const result =
            p.command.action === 'set'
              ? await controller.set(p.target, p.command.enabled)
              : undefined;
          const snapshot = controller.getSnapshot();
          return {
            ok: true,
            noise: Object.fromEntries(roles(p.target).map((slot) => [slot, snapshot[slot]])),
            ...(result ? { result } : {}),
          };
        }
        case 'fusion_device_read': {
          const p = schemas.fusion_device_read.parse(a);
          if (p.noise)
            return execute('fusion_noise', { target: p.target, command: p.noise }, execution);
          if (p.auth) {
            const service = adapter.auth;
            if (!service) throw new Error('Device authentication is unavailable in this client');
            const command = p.auth,
              selected = roles(p.target);
            const states = () =>
              Object.fromEntries(selected.map((slot) => [slot, service.getSnapshot()[slot]]));
            if (command.action === 'recovery') {
              if (!context)
                throw new Error(
                  'Password recovery requires a trusted browser or authenticated bridge context',
                );
              const recovery = service.recovery;
              if (!recovery) throw new Error('Password recovery is unavailable in this client');
              recovery.refreshBindings();
              const request = command.recovery!;
              const recoveryStates = () =>
                Object.fromEntries(selected.map((slot) => [slot, recovery.getSnapshot()[slot]]));
              if (request.action === 'status') return { ok: true, recovery: recoveryStates() };
              if (request.action === 'clear') {
                selected.forEach((slot) => recovery.clear(slot));
                return { ok: true, recovery: recoveryStates() };
              }
              const role = selected[0];
              if (request.action === 'discard-code') {
                recovery.discardCodeReview(role);
                return { ok: true, recovery: recoveryStates() };
              }
              const result = await adapter.operate('Agent: OEM password recovery', async () => {
                if (request.action === 'review')
                  return recovery.review(role, {
                    source: request.source,
                    ...(request.sourceConfirmed ? { sourceConfirmed: true } : {}),
                  });
                if (request.action === 'confirm-challenge')
                  return recovery.confirmChallenge(role, {
                    reviewId: request.reviewId,
                    revision: request.revision,
                    uniqueKey: request.uniqueKey,
                    confirm: request.confirm,
                  });
                if (request.action === 'review-code')
                  return recovery.reviewCode(role, {
                    reviewId: request.reviewId,
                    revision: request.revision,
                    code: request.code,
                    source: request.source,
                  });
                if (request.action === 'submit-code')
                  return recovery.submitCode(role, {
                    reviewId: request.reviewId,
                    revision: request.revision,
                    codeReviewId: request.codeReviewId,
                    source: request.source,
                    confirm: request.confirm,
                  });
                throw new Error('Unknown password recovery action');
              });
              return { ok: true, recovery: recoveryStates(), result };
            }
            if (command.action === 'clear') {
              selected.forEach((slot) => service.clear(slot));
              return { ok: true, auth: states() };
            }
            if (command.action === 'status') {
              const results = await Promise.allSettled(
                selected.map((slot) => service.status(slot, command.refresh ?? true)),
              );
              return {
                ok: results.every((result) => result.status === 'fulfilled'),
                auth: states(),
                results: results.map((result, index) => ({
                  slot: selected[index],
                  ok: result.status === 'fulfilled',
                  ...(result.status === 'rejected'
                    ? {
                        error:
                          result.reason instanceof Error
                            ? result.reason.message
                            : 'Authentication status failed',
                      }
                    : {}),
                })),
              };
            }
            const role = selected[0];
            if (command.action === 'oem-discard') {
              service.discardOemProposal(role);
              return { ok: true, auth: states() };
            }
            if (command.action === 'email-read') {
              const bytes = await service.readEmail(role);
              try {
                return {
                  ok: true,
                  auth: states(),
                  email: { slot: role, bytes: Array.from(bytes) },
                };
              } finally {
                bytes.fill(0);
              }
            }
            const result =
              command.action === 'unlock'
                ? await service.unlock(role, command.credential!)
                : command.action === 'password-change'
                  ? await service.change(role, {
                      current: command.current,
                      next: command.next!,
                      confirm: command.confirm!,
                      email: command.email!,
                    })
                  : command.action === 'email-set'
                    ? await service.writeEmail(role, command.email!)
                    : command.action === 'oem-propose'
                      ? await service.proposeOem(role, command.mask!)
                      : await service.saveOem(role, command.proposalId!);
            return { ok: true, auth: states(), result };
          }
          if (p.firmware) {
            const runtimeCommand = p.firmware;
            if (runtimeCommand.action.startsWith('update-')) {
              if (!context)
                throw new Error(
                  'Firmware execution requires a trusted workspace execution context',
                );
              const workflow = adapter.firmwareExecution;
              if (!workflow)
                throw new Error('Firmware execution workflow is unavailable in this client');
              const actor = {
                ...parseExecutionPrincipal({ owner: context.owner, scope: context.scope }),
                ...(signal ? { signal } : {}),
              };
              const current = workflow.status(actor);
              if (runtimeCommand.reviewId) {
                const fixed =
                  current.update.activeReview?.id === runtimeCommand.reviewId
                    ? current.update.activeReview
                    : current.update.records.find(
                        (record) => record.id === runtimeCommand.reviewId,
                      );
                if (fixed && fixed.target !== p.target)
                  throw new Error(
                    'Firmware target differs from the fixed review or consumed record',
                  );
              }
              let result: unknown;
              switch (runtimeCommand.action) {
                case 'update-review':
                  result = await workflow.review(p.target, runtimeCommand.stageIds!, actor);
                  break;
                case 'update-apply':
                  result = await workflow.apply(runtimeCommand.reviewId!, actor, { confirm: true });
                  break;
                case 'update-discard':
                  workflow.discard(runtimeCommand.reviewId!, actor);
                  break;
                case 'update-review-recovery':
                  result = await workflow.reviewRecovery(runtimeCommand.recordId!, p.target, actor);
                  break;
                case 'update-history':
                  await workflow.hydrate(actor);
                  return {
                    ok: true,
                    history: workflow.history(actor, runtimeCommand.offset, runtimeCommand.limit),
                  };
                case 'update-export':
                  return {
                    ok: true,
                    export: workflow.exportPage(
                      runtimeCommand.recordId!,
                      actor,
                      runtimeCommand.offset,
                      runtimeCommand.limit,
                    ),
                  };
              }
              return {
                ok: true,
                firmwareUpdate: workflow.status(actor),
                ...(result === undefined ? {} : { result }),
              };
            }
            if (runtimeCommand.action.startsWith('runtime-')) {
              if (!context)
                throw new Error(
                  'Firmware runtime inspection requires a trusted workspace execution context',
                );
              const runtime = adapter.firmwareRuntime;
              if (!runtime)
                throw new Error('Firmware runtime inspection is unavailable in this client');
              const actor = {
                ...parseExecutionPrincipal({ owner: context.owner, scope: context.scope }),
                ...(signal ? { signal } : {}),
              };
              if (runtimeCommand.action === 'runtime-read') {
                await runtime.read(p.target, actor);
                adapter.view({ tab: 'Device settings' });
              } else if (runtimeCommand.action === 'runtime-clear') runtime.clear(p.target, actor);
              const state = runtime.status(actor);
              return {
                ok: true,
                runtime: {
                  busy: state.busy,
                  revision: state.revision,
                  roles: Object.fromEntries(
                    roles(p.target).map((slot) => [slot, state.roles[slot]]),
                  ),
                },
              };
            }
            const service = adapter.firmware;
            if (!service) throw new Error('Firmware file staging is unavailable in this client');
            if (adapter.firmwareExecution) {
              if (!context)
                throw new Error('Firmware staging requires a trusted workspace execution context');
              adapter.firmwareExecution.status(context);
            }
            const command = p.firmware,
              slots = roles(p.target);
            const states = () =>
              Object.fromEntries(slots.map((slot) => [slot, service.getSnapshot()[slot]]));
            if (command.action.startsWith('usb-')) {
              const verifier = adapter.descriptorVerifier;
              if (!verifier)
                throw new Error('USB descriptor verification is unavailable in this client');
              const descriptors = () =>
                Object.fromEntries(
                  slots.map((slot) => [
                    slot,
                    {
                      ...verifier.getSnapshot()[slot],
                      availability: verifier.availability(slot),
                    },
                  ]),
                );
              if (command.action === 'usb-status')
                return { ok: true, descriptors: descriptors(), firmware: states() };
              if (command.action === 'usb-clear') {
                slots.forEach((slot) => {
                  verifier.clear(slot);
                  service.refreshTarget(slot);
                });
                return { ok: true, descriptors: descriptors(), firmware: states() };
              }
              const results = await Promise.allSettled(
                slots.map(async (slot) => {
                  try {
                    if (command.action === 'usb-choose') await verifier.request(slot);
                    else await verifier.revalidate(slot);
                  } finally {
                    service.refreshTarget(slot);
                  }
                }),
              );
              return {
                ok: results.every((result) => result.status === 'fulfilled'),
                descriptors: descriptors(),
                firmware: states(),
                results: results.map((result, index) => ({
                  slot: slots[index],
                  ok: result.status === 'fulfilled',
                  ...(result.status === 'rejected'
                    ? { error: String(result.reason).slice(0, 4096) }
                    : {}),
                })),
              };
            }
            if (command.action === 'status') return { ok: true, firmware: states() };
            if (command.action === 'clear') {
              slots.forEach((slot) => {
                if (adapter.firmwareExecution) {
                  if (!context)
                    throw new Error(
                      'Firmware staging requires a trusted workspace execution context',
                    );
                  adapter.firmwareExecution.clear(slot, context);
                } else service.clear(slot);
              });
              return { ok: true, firmware: states() };
            }
            if (command.action === 'packets')
              return {
                ok: true,
                packetPage: service.packetPreview(
                  slots[0],
                  command.pass!,
                  command.offset,
                  command.limit,
                ),
              };
            return adapter.operate('Agent: inspecting firmware file', async () => {
              const results = await Promise.allSettled(
                slots.map((slot) => {
                  if (adapter.firmwareExecution) {
                    if (!context)
                      throw new Error(
                        'Firmware staging requires a trusted workspace execution context',
                      );
                    return adapter.firmwareExecution.inspect(
                      slot,
                      command.content!,
                      command.name!,
                      context,
                    );
                  }
                  return service.inspect(slot, command.content!, command.name!);
                }),
              );
              return {
                ok: results.every((result) => result.status === 'fulfilled'),
                firmware: states(),
                results: results.map((result, index) => ({
                  slot: slots[index],
                  ok: result.status === 'fulfilled',
                  ...(result.status === 'rejected'
                    ? { error: String(result.reason).slice(0, 4096) }
                    : {}),
                })),
              };
            });
          }
          return await adapter.operate('Agent: reading settings', async () => {
            const devices = await Promise.all(
              roles(p.target).map(async (s) => {
                const l = get(s),
                  status = await l.session.status(),
                  hardware = await l.session.hardwareOverview(),
                  protection = await l.session.protection(),
                  limiter = await l.session.limiter(),
                  power = await l.session.powerStatistics();
                return {
                  slot: s,
                  identity: hardware.identity,
                  hardware,
                  protection,
                  options: settings(status),
                  metering: decodeMetering(status),
                  health: decodeHealth(status),
                  limiter: { amplifier: limiter.amplifier, channels: limiter.channels },
                  power,
                };
              }),
            );
            return { ok: true, devices };
          });
        }
        case 'fusion_amplifier_modes':
          return await executeAmplifierModesTool(a, {
            controller: adapter.amplifierModes,
            context: context ? { ...context, ...(signal ? { signal } : {}) } : undefined,
            view: () => adapter.view({ tab: 'Device settings' }),
          });
        case 'fusion_native_mixer':
          return await executeNativeMixerTool(a, {
            controller: adapter.nativeMixer,
            context: context ? { ...context, ...(signal ? { signal } : {}) } : undefined,
            view: (preset) => {
              // Preset selection must not initialize the Crossover graph while
              // revealing this separate device editor.
              adapter.view({ tab: 'Device settings' });
              if (preset !== undefined) adapter.choose({ preset: preset - 1 });
            },
            files: adapter.files,
            transferPage,
          });
        case 'fusion_device_clone':
          return await executeDeviceCloneTool(a, {
            controller: adapter.deviceClone,
            context: context ? { ...context, ...(signal ? { signal } : {}) } : undefined,
            view: () => adapter.view({ tab: 'Device settings' }),
            files: adapter.files,
            transferPage,
          });
        case 'fusion_device_defaults': {
          const p = schemas.fusion_device_defaults.parse(a),
            controller = adapter.deviceDefaults;
          if (!controller) throw new Error('Device Defaults is unavailable in this workspace');
          if (!context)
            throw new Error('Device Defaults requires a trusted workspace execution context');
          const actor = {
            ...parseExecutionPrincipal({ owner: context.owner, scope: context.scope }),
            ...(signal ? { signal } : {}),
          };
          if (p.action === 'status')
            return {
              ok: true,
              defaults: deviceDefaultsSnapshotPage(
                controller.status(actor),
                p.offset ?? 0,
                p.limit ?? 10,
              ),
            };
          if (p.action === 'refresh-history') {
            await controller.hydrate(actor);
            return { ok: true, defaults: deviceDefaultsSnapshotPage(controller.status(actor)) };
          }
          if (p.action === 'review') {
            const review = await controller.reviewDefaults(p.target, actor);
            adapter.view({ tab: 'Device settings' });
            return { ok: true, review };
          }
          if (p.action === 'review-recovery') {
            const review = await controller.reviewRecovery(p.id, actor);
            adapter.view({ tab: 'Device settings' });
            return { ok: true, review };
          }
          if (p.action === 'discard-review') {
            controller.discard(p.reviewId, actor);
            return { ok: true };
          }
          if (p.action === 'export-record') {
            const record = controller.exportRecord(p.id, actor);
            if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 64 * 1024)
              throw new Error('This Device Defaults journal exceeds the bounded export size');
            return { ok: true, record };
          }
          const record =
            p.action === 'restore'
              ? await controller.restore(p.reviewId, actor, { confirm: true })
              : await controller.apply(p.reviewId, actor, { confirm: true });
          return { ok: true, record: deviceDefaultsRecordSummary(record) };
        }
        case 'fusion_power': {
          const p = schemas.fusion_power.parse(a),
            slots = roles(p.target);
          const devices = await adapter.operate('Agent: DSP power', async () => {
            await preflightTargets(slots, (slot) =>
              get(slot).session.preflightOperation('deviceSettings'),
            );
            return Promise.all(
              slots.map(async (s) => ({
                slot: s,
                power: await get(s).session.setPower(p.state === 'on'),
              })),
            );
          });
          await adapter.refresh(slots);
          return { ok: true, devices };
        }
        case 'fusion_limiter_editor': {
          const p = schemas.fusion_limiter_editor.parse(a),
            controller = adapter.nativeLimiter;
          if (!controller)
            throw new Error('The native limiter editor is unavailable in this workspace');
          if (!context)
            throw new Error(
              'The native limiter editor requires a trusted workspace execution context',
            );
          const actor = {
            ...parseExecutionPrincipal({ owner: context.owner, scope: context.scope }),
            ...(signal ? { signal } : {}),
          };
          if (p.action === 'status')
            return { ok: true, limiter: nativeLimiterSnapshotPage(controller.status(actor)) };
          if (p.action === 'load') {
            await controller.load(p.target, actor);
            adapter.view({ tab: 'Device settings' });
            return { ok: true, limiter: nativeLimiterSnapshotPage(controller.status(actor)) };
          }
          if (p.action === 'edit') {
            const action =
              'channel' in p.edit
                ? { ...p.edit, channel: (p.edit.channel - 1) as 0 | 1 | 2 }
                : p.edit;
            controller.edit(p.target, actor, {
              expectedRevision: p.expectedRevision,
              action: action as NativeLimiterEditAction,
            });
            adapter.view({ tab: 'Device settings' });
            return { ok: true, limiter: nativeLimiterSnapshotPage(controller.status(actor)) };
          }
          if (p.action === 'review') {
            const review = await controller.review(p.target, actor, {
              expectedRevision: p.expectedRevision,
            });
            adapter.view({ tab: 'Device settings' });
            return { ok: true, review };
          }
          if (p.action === 'discard-review') {
            controller.discard(p.reviewId, actor);
            return { ok: true };
          }
          return { ok: true, result: await controller.apply(p.reviewId, actor, { confirm: true }) };
        }
        case 'fusion_limiter_set': {
          const p = schemas.fusion_limiter_set.parse(a),
            slots = roles(p.target);
          const devices = await adapter.operate('Agent: updating limiter', async () => {
            await preflightTargets(slots, (slot) => get(slot).session.preflightLimiter(p.channels));
            return Promise.all(
              slots.map(async (s) => ({
                slot: s,
                limiter: (await get(s).session.setLimiter(p.channels)).channels,
              })),
            );
          });
          await adapter.refresh(slots);
          return { ok: true, devices };
        }
        case 'fusion_configuration_backup': {
          const p = schemas.fusion_configuration_backup.parse(a);
          return await adapter.operate('Agent: configuration backup', async () => ({
            ok: true,
            backups: await Promise.all(
              roles(p.target).map((s) => get(s).session.backupConfiguration()),
            ),
          }));
        }
        case 'fusion_configuration_backups': {
          const p = schemas.fusion_configuration_backups.parse(a);
          return {
            ok: true,
            backups: (await listConfigurationBackups()).filter(
              (b) => !p.serial || b.serial === p.serial,
            ),
          };
        }
        case 'fusion_configuration_restore': {
          const p = schemas.fusion_configuration_restore.parse(a),
            backup = (await listConfigurationBackups()).find((b) => b.id === p.backupId);
          if (!backup) throw new Error('Configuration backup not found');
          await adapter.operate('Agent: restoring device configuration', () =>
            get(p.slot).session.restoreConfiguration(backup),
          );
          await adapter.refresh([p.slot]);
          break;
        }
      }
      adapter.message(`${TOOL_DESCRIPTIONS[key].split('.')[0]} · completed`);
      return { ok: true };
    } catch (e) {
      if (
        signal?.aborted &&
        !(e instanceof NativeLimiterError && e.result) &&
        !(e instanceof DeviceCloneError && e.result) &&
        !(e instanceof AmplifierModesError && e.result) &&
        !(e instanceof NativeMixerError && e.result) &&
        !(e instanceof FirmwareExecutionError && e.result)
      )
        throw e;
      return {
        ok: false,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 16384),
        ...(e instanceof ProjectUploadError || e instanceof EqBankUploadError
          ? { results: e.results }
          : {}),
        ...(e instanceof DeviceAuthOperationError && e.result ? { result: e.result } : {}),
        ...(e instanceof DeviceDefaultsError && e.result
          ? { result: deviceDefaultsRecordSummary(e.result) }
          : {}),
        ...(e instanceof NativeLimiterError && e.result ? { result: e.result } : {}),
        ...(e instanceof AmplifierModesError && e.result ? { result: e.result } : {}),
        ...(e instanceof NativeMixerError && e.result ? { result: e.result } : {}),
        ...(e instanceof FirmwareRuntimeDiagnosticError ? { runtime: e.runtime } : {}),
        ...(e instanceof FirmwareExecutionError
          ? { persistence: e.persistence, ...(e.result ? { result: e.result } : {}) }
          : {}),
        ...(e instanceof DeviceCloneError
          ? {
              persistence: e.persistence,
              ...(e.result ? { result: deviceCloneRecordSummary(e.result) } : {}),
            }
          : {}),
        ...(e instanceof PasswordRecoveryError && e.result ? { result: e.result } : {}),
        ...(e instanceof NoiseControlError && e.result ? { result: e.result } : {}),
        ...(e instanceof DirectorySaveError
          ? {
              code: e.code,
              needsHumanGrant: e.needsHumanGrant,
              ...(e.result ? { proposal: directoryProposalPage(e.result) } : {}),
            }
          : {}),
        ...(e instanceof ProjectSourcesError
          ? {
              code: e.code,
              needsHumanGrant: e.needsHumanGrant,
              ...(e.recentWarning ? { recentWarning: e.recentWarning } : {}),
            }
          : {}),
      };
    }
  };
}
const SLOTS_LOCAL: Slot[] = ['left', 'right'];
