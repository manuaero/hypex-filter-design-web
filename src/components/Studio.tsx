'use client';
import Numeric, { type NumericFocusOperation } from './Numeric';
import FilterPalette, { FilterGlyph, FILTER_LABELS, hasQ } from './FilterPalette';
import FilterCards from './FilterCards';
import EqPresetActions from './EqPresetActions';
import LiveEqToggle from './LiveEqToggle';
import LiveMeters from './LiveMeters';
import NoisePanel from './NoisePanel';
import { createNoiseController } from '../application/noise-control';
import { type EqBank, editInputEqBand } from '../domain/equalizer';
import { planSelectedFirPlacement } from '../domain/fir-state';
import {
  planChannelEdit,
  applyChannelEdit,
  type ChannelEditPatch,
  type ChannelEditOptions,
} from '../domain/channel-editing';
import { hardwareGainPresentation } from '../domain/hardware-gain';
import { HFD_CHANNEL_GAIN_BOUNDS } from '../domain/channel-gain';
import { supportsHfdGraphQ } from '../domain/manual-graph-q';
import {
  captureManualFilterDrag,
  planManualFilterDrag,
  applyManualFilterDrag,
} from '../domain/graph-drag';
import { EqBankUploadError } from '../hardware/eq-bank';
import SignalChain from './SignalChain';
import {
  exchangeBiquads,
  copyChannelProcessing,
  clearPreset,
  deleteBiquad,
  isUnusedBiquad,
  editManualFilter,
  planManualFilterWheel,
  applyManualFilterWheel,
  type ManualFilterParameter,
  type ManualFilterPatch,
} from '../domain/editing';
import type { HfdManualWheelResult } from '../domain/parameter-wheel';
import { normalizeHfdManualFrequencyText } from '../domain/manual-frequency';
import {
  normalizeHfdManualQText,
  normalizeHfdManualGainText,
  formatHfdManualQValue,
  formatHfdManualGainValue,
  HFD_MANUAL_Q_BOUNDS,
  HFD_MANUAL_GAIN_BOUNDS,
} from '../domain/manual-parameter';
import { HFD_INPUT_EQ_PROFILE } from '../domain/input-eq-parameters';
import InteractivePlot, { type PlotRange } from './InteractivePlot';
import { createPlotViewController } from '../application/plot-view';
import {
  createNativeImpulseView,
  nativeImpulseZoomFromRange,
  projectNativeImpulseZoom,
  type NativeImpulseBinding,
} from '../application/native-impulse-view';
import { defaultPlotRange, validatePlotRange } from '../domain/plot-viewport';
import PlotLayerControls from './PlotLayerControls';
import PhaseLayers from './PhaseLayers';
import {
  createGraphViewController,
  type GraphViewPatch,
  type GraphViewPlan,
} from '../application/graph-view';
import { createNativeGraphEntryController } from '../application/native-graph-entry';
import ProjectLibrary from './ProjectLibrary';
import SourceBrowser from './SourceBrowser';
import ProjectSaveDialog from './ProjectSaveDialog';
import { directorySnapshotPage } from '../application/directory-save-view';
import { createWorkspaceAuthority } from '../application/workspace-authority';
import {
  createWorkspaceDirectoryWriter,
  type DirectoryLegacyReview,
} from '../application/workspace-directory';
import {
  createProjectDirectoryWriter,
  type DirectorySaveBinding,
} from '../application/project-directory-writer';
import { useProjectSourceOpen } from './useProjectSourceOpen';
import { createWorkspaceProjectSources } from '../application/browser-project-sources';
import Measurements, { type MeasurementView } from './Measurements';
import CapturePanel from './CapturePanel';
import {
  createCaptureController,
  type CaptureController,
} from '../application/measurement-capture';
import { createBrowserCaptureBackend } from '../audio/browser-capture';
import { loadCapturePreferences, saveCapturePreferences } from '../audio/capture-preferences';
import { type ToolExecutionContext } from '../application/execution-context';
import {
  uploadProjectPair,
  ProjectUploadError,
  type ProjectUploadResult,
} from '../hardware/project-upload';
import { linkChannel } from '../domain/links';
import FirPanel from './FirPanel';
import { applyNativeFirAction, applyReadFir } from '../domain/fir-editing';
import DeviceSettings from './DeviceSettings';
import DeviceDefaultsPanel from './DeviceDefaultsPanel';
import { createDeviceDefaultsController } from '../application/device-defaults';
import { createDeviceCloneController, deviceCloneSnapshotPage } from '../application/device-clone';
import { createCloneWorkspace } from '../application/clone-workspace';
import { createAmplifierModesController } from '../application/amplifier-modes';
import { createNativeMixerController } from '../application/native-mixer';
import NativeMixerPanel from './NativeMixerPanel';
import {
  createNativeProjectSaveController,
  type NativeProjectSaveController,
} from '../application/native-project-save';
import AmplifierConfiguration from './AmplifierConfiguration';
import DeviceClonePanel from './DeviceClonePanel';
import { exportNativeCloneProject, nativeCloneProjectFiles } from '../domain/clone-project';
import { deviceDefaultsSnapshotPage } from '../application/device-defaults-view';
import NativeLimiterPanel from './NativeLimiterPanel';
import {
  createNativeLimiterController,
  nativeLimiterSnapshotPage,
} from '../application/native-limiter';
import FirmwarePanel from './firmware-panel';
import { createFirmwareWorkspace } from '../application/firmware-workspace';
import {
  createFirmwareExecutionWorkflow,
  planFirmwareRecoveryAssignments,
  type FirmwareAssignmentLease,
  type FirmwareExecutionWorkflow,
} from '../application/firmware-execution';
import { createFirmwareUpdateCoordinator } from '../hardware/firmware-update';
import { createFirmwareWebHidUpdateAdapter } from '../hardware/firmware-webhid-adapter';
import type { FirmwareJournalBinding } from '../application/firmware-update-storage';
import {
  createFirmwareRuntimeController,
  FirmwareRuntimeDiagnosticError,
} from '../application/firmware-runtime';
import { createFirmwareRuntimeSourceProvider } from '../application/firmware-runtime-source';
import { FirmwareRuntimeSerialMismatchError } from '../hardware/firmware-runtime-inspector';
import { UnsupportedPanelRuntimeError } from '../hardware/session';
import { createUsbDescriptorVerifier } from '../hardware/usb-descriptor';
import DeviceAuthPanel from './DeviceAuthPanel';
import { createDeviceAuthController } from '../application/device-auth';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  AudioLines,
  Cable,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  Download,
  FolderOpen,
  Link2,
  LoaderCircle,
  Plus,
  Power,
  Radio,
  Redo2,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Undo2,
  Unplug,
  Volume2,
  VolumeX,
  Waves,
  X,
} from 'lucide-react';
import {
  useWorkspace,
  ensureWorkspaceHydrated,
  retryWorkspacePersistence,
  flushWorkspacePersistence,
  getWorkspacePersistenceStatus,
  subscribeWorkspacePersistence,
  getWorkspaceRecoveryText,
} from '../state/workspace';
import { SERVER_WORKSPACE_PERSISTENCE_STATUS } from '../state/persistence';
import {
  newFilter,
  newProject,
  SLOTS,
  type Slot,
  type Filter,
  type FilterKind,
  type Channel,
  type Preset,
  type Project,
} from '../domain/model';
import { projectFiles, zipFiles, downloadBytes } from '../domain/project-io';
import { FILTER_NAMES, design, effectiveSections, encodeChannel } from '../domain/dsp';
import {
  parseProject,
  download,
  exportHfd,
  parseFir,
  parseMeasurement,
  resolveGainCache,
} from '../domain/files';
import { PanelSession, uploadPair, type Backup, type Identity } from '../hardware/session';
import { WebHidTransport } from '../hardware/transport';
import { listBackups, saveBackup } from '../hardware/storage';
import { importBackupFile } from '../hardware/backup-file';
import { VID, PID, type PanelStatus, type Controls, hex, encodeEq } from '../hardware/codec';
import ResponsePlot, { COLORS, type PlotMode } from './ResponsePlot';
import { inputEqAnalysisChannel } from '../domain/input-eq-analysis';
import { selectedSectionAnalysisChannel, selectedSectionCoefficients } from '../domain/plot-layers';
import { analyzeTimeResponses } from '../domain/time-analysis';
import { fitTimeSeries } from '../domain/time-series';
import { importChannelMeasurement } from '../domain/hfd-measurement';
import { spectrum } from '../domain/measurement';
import { hfdCentering } from '../domain/hfd-response-view';
import {
  loadProjectMicrophone,
  unloadProjectMicrophone,
  setProjectMicrophoneOptions,
  inheritProjectMicrophone,
} from '../domain/hfd-microphone';
import AgentAccess from './AgentAccess';
import HelpAbout from './HelpAbout';
import {
  createToolExecutor,
  type ToolAdapter,
  type ToolName,
  type HardwareGainEditorLocation,
} from '../application/tools';
import { createFileTransfers } from '../application/file-transfers';
import { readFileText } from '../application/file-budget';
import { settings } from '../hardware/codec';
import { inputSourceLabel } from '../hardware/input-sources';

const TABS = [
  'Crossover',
  'Input EQ',
  'FIR',
  'Measurements',
  'Device settings',
  'Backups',
  'Help',
  'Verification',
  'Agent access',
] as const;
type Live = {
  session: PanelSession;
  identity: Identity;
  status: PanelStatus;
  device: HIDDevice;
  connectionId: string;
};
const fmt = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(2)}k` : `${+v.toFixed(2)}`);
// Passive compensation field display only; the retained canonical Double is untouched.
function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="toggle-label">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
      {children}
    </label>
  );
}
type PaletteScope = {
  mode: 'add' | 'replace';
  index: number;
  slot: Slot;
  slots: Slot[];
  preset: number;
  channel: number;
  eq: boolean;
};
type SaveDialogCapture = {
  binding: DirectorySaveBinding;
  project: Project;
  legacyReview?: DirectoryLegacyReview;
};
export default function Studio() {
  const workspaceAuthority = useMemo(() => createWorkspaceAuthority(), []);
  const authorityStatus = useSyncExternalStore(
    workspaceAuthority.subscribe,
    workspaceAuthority.getSnapshot,
    workspaceAuthority.getSnapshot,
  );
  const authorityLifetime = useRef(0);
  const fileTransfers = useMemo(() => createFileTransfers(), []);
  const nativeSaveRef = useRef<NativeProjectSaveController | undefined>(undefined);
  const plotController = useMemo(() => createPlotViewController(), []);
  const nativeImpulseView = useMemo(
    () =>
      createNativeImpulseView({
        plots: plotController,
        state: useWorkspace.getState,
        edit: (slots, change, options) => useWorkspace.getState().editAt(slots, change, options),
      }),
    [plotController],
  );
  const projectSources = useMemo(
    () =>
      createWorkspaceProjectSources({
        getWorkspace: () => ({
          commitFileImport: commitWorkspaceFile,
          lookupFileCommit: (...args) => useWorkspace.getState().lookupFileCommit(...args),
        }),
      }),
    [],
  );
  const directoryCore = useMemo(
    () =>
      createProjectDirectoryWriter({
        getProject: (slot) => useWorkspace.getState().documents[slot],
        getRevision: () => useWorkspace.getState().documentRevision ?? 0,
        captureExport: (binding, project) => {
          if (!nativeSaveRef.current) throw new Error('Project Save capture is unavailable');
          return nativeSaveRef.current.ticket(binding, project);
        },
      }),
    [],
  );
  const directoryWriter = useMemo(
    () => createWorkspaceDirectoryWriter({ writer: directoryCore, authority: workspaceAuthority }),
    [directoryCore, workspaceAuthority],
  );
  const projectSourceOpener = useProjectSourceOpen(projectSources);
  const sourceOpenStatus = () => {
    const { busy, pending } = projectSourceOpener.getStatus();
    return {
      busy,
      ...(pending
        ? {
            pending: {
              sourceId: pending.sourceId,
              target: pending.target,
              expectedRevision: pending.expectedRevision,
              requestId: pending.requestId,
            },
          }
        : {}),
    };
  };
  const projectSourceContext = useRef<ToolExecutionContext | undefined>(undefined);
  const graphController = useMemo(() => createGraphViewController(), []);
  const projectViewGenerations = useRef<Record<Slot, number>>({ left: 0, right: 0 });
  const nativeGraphEntries = useMemo(
    () => createNativeGraphEntryController({ current: useWorkspace.getState }),
    [],
  );
  const plotViews = useSyncExternalStore(
    plotController.subscribe,
    plotController.getSnapshot,
    plotController.getSnapshot,
  );
  const graphViews = useSyncExternalStore(
    graphController.subscribe,
    graphController.getSnapshot,
    graphController.getSnapshot,
  );
  const persistenceStatus = useSyncExternalStore(
    subscribeWorkspacePersistence,
    getWorkspacePersistenceStatus,
    () => SERVER_WORKSPACE_PERSISTENCE_STATUS,
  );
  const w = useWorkspace(),
    project = w.documents[w.slot],
    preset = project.presets[w.preset],
    channel = preset.channels[w.channel],
    graphView = graphViews[w.slot],
    { sum, measured } = graphView;
  const uploadFirWarnings = useMemo(
    () =>
      SLOTS.flatMap((slot) =>
        w.documents[slot].presets.flatMap((design, index) => {
          try {
            return planSelectedFirPlacement(design).warnings.map((message) => ({
              slot,
              preset: index + 1,
              message,
            }));
          } catch {
            // Rendering remains usable; existing upload preflight refuses
            // malformed resources before any amplifier mutation.
            return [];
          }
        }),
      ),
    [w.documents],
  );
  const [hydrated, setHydrated] = useState(false),
    [tab, setTab] = useState<(typeof TABS)[number]>('Crossover'),
    [authView, setAuthView] = useState<'closed' | 'password' | 'permissions'>('closed'),
    [showMeters, setShowMeters] = useState(false),
    [showNoise, setShowNoise] = useState(false),
    [saveDialog, setSaveDialog] = useState<SaveDialogCapture>(),
    [healthDetails, setHealthDetails] = useState(false),
    [mode, setMode] = useState<PlotMode>('Magnitude'),
    [measurementView, setMeasurementView] = useState<MeasurementView>('frequency'),
    [calibrationCurve, setCalibrationCurve] = useState(false),
    [nativeCentered, setNativeCentered] = useState(true),
    [showUnloadedFilters, setShowUnloadedFilters] = useState(false),
    [documentEpochs, setDocumentEpochs] = useState({ left: 0, right: 0 }),
    [live, setLive] = useState<Partial<Record<Slot, Live>>>({}),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState('Design locally. Connect an amplifier when you are ready.'),
    [error, setError] = useState(''),
    [uploadReport, setUploadReport] = useState<ProjectUploadResult[]>([]),
    [progress, setProgress] = useState<Partial<Record<Slot, { percent: number; message: string }>>>(
      {},
    ),
    [backups, setBackups] = useState<Backup[]>([]),
    [eqIndex, setEqIndex] = useState(0),
    [eqClipboardLabel, setEqClipboardLabel] = useState(''),
    [showRaw, setShowRaw] = useState(false),
    [expertBank, setExpertBank] = useState(false),
    [designer, setDesigner] = useState<'graph' | 'chain'>('graph'),
    [selectedBiquads, setSelectedBiquads] = useState<number[]>([]),
    [copySourceChannel, setCopySourceChannel] = useState<number | null>(null),
    [palette, setPalette] = useState<PaletteScope>(),
    [paletteDraft, setPaletteDraft] = useState<Filter>(() => newFilter('peak')),
    [paletteFailure, setPaletteFailure] = useState('');
  const paletteEnabledExplicit = useRef(false);
  // Native channel graph windows retain checkbox eligibility after Off. This
  // trusted presentation state is per view, never imported/caller-authored data.
  const retainedHardwareGainViews = useRef(new Map<string, HardwareGainEditorLocation>());
  const hardwareGainInput = useRef<HTMLDivElement>(null);
  const saveDialogRef = useRef<SaveDialogCapture | undefined>(undefined);
  const [audioAccess, setAudioAccess] = useState<{
    controller: CaptureController;
    context: ToolExecutionContext;
  }>();
  useEffect(() => {
    const lifetime = ++authorityLifetime.current;
    let cancelled = false;
    void workspaceAuthority
      .hydrate()
      .then(() => {
        if (!cancelled)
          setError((current) => (current.startsWith('Workspace access: ') ? '' : current));
      })
      .catch((error) => {
        if (!cancelled)
          setError(`Workspace access: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      cancelled = true;
      // Strict Mode replays effects synchronously. Only the final unmount
      // disposes this memoized authority; bridge children revoke immediately.
      queueMicrotask(() => {
        if (authorityLifetime.current === lifetime) workspaceAuthority.dispose();
      });
    };
  }, [workspaceAuthority]);
  const modeRef = useRef(mode);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const designerRef = useRef(designer);
  designerRef.current = designer;
  const nativeRangeGesture = useRef<NativeImpulseBinding | undefined>(undefined);
  async function commitWorkspaceFile(
    ...args: Parameters<ReturnType<typeof useWorkspace.getState>['commitFileImport']>
  ) {
    let applied = false;
    const forwarded = [...args] as typeof args;
    forwarded[4] = (destination) => {
      applied = true;
      args[4](destination);
    };
    try {
      return await useWorkspace.getState().commitFileImport(...forwarded);
    } finally {
      const metadata = args[5];
      if (
        applied &&
        useWorkspace.getState().fileCommitReceipts?.[args[0]] &&
        metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        ['project', 'folder', 'source-open'].includes(String(metadata.workflow))
      )
        projectViewsReplaced(args[3]);
      else if (
        applied &&
        useWorkspace.getState().fileCommitReceipts?.[args[0]] &&
        metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        ['measurement-text', 'measurement-wav'].includes(String(metadata.workflow)) &&
        typeof metadata.preset === 'number' &&
        typeof metadata.channel === 'number'
      )
        refreshPhaseMeasurements(args[3], metadata.preset - 1, [metadata.channel - 1]);
    }
  }
  function openProjectSave() {
    if (saveDialogRef.current) return;
    if (workspaceAuthority.getSnapshot().phase !== 'ready') {
      setError(
        'Workspace access: wait for identity storage, or retry workspace access in Agent access.',
      );
      return;
    }
    const current = useWorkspace.getState();
    const principal = (projectSourceContext.current ??= workspaceAuthority.localContext('ui'));
    let capture;
    try {
      capture = nativeProjectSave.stage(
        { target: current.slot, expectedRevision: current.documentRevision ?? 0, mode: 'auto' },
        principal,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Project Save could not be staged');
      return;
    }
    const captured = {
      binding: {
        slot: current.slot,
        expectedRevision: current.documentRevision ?? 0,
        requestId: crypto.randomUUID(),
        principal,
        exportId: capture.id,
        metadata: 'auto' as const,
      },
      project: structuredClone(current.documents[current.slot]),
    };
    saveDialogRef.current = captured;
    setSaveDialog(captured);
  }
  function closeProjectSave() {
    if (directoryWriter.getSnapshot().busy)
      throw new Error('Finish the current folder operation before closing its review');
    const captured = saveDialogRef.current;
    if (
      captured?.binding.exportId &&
      nativeProjectSave
        .getSnapshot()
        .captures.some((entry) => entry.id === captured.binding.exportId)
    )
      nativeProjectSave.release(captured.binding.exportId, captured.binding.principal);
    saveDialogRef.current = undefined;
    setSaveDialog(undefined);
  }
  function replaceProjectSaveCapture(mode: 'auto' | 'design') {
    const captured = saveDialogRef.current;
    if (!captured || directoryWriter.getSnapshot().busy) return;
    try {
      if (
        captured.binding.exportId &&
        nativeProjectSave
          .getSnapshot()
          .captures.some((entry) => entry.id === captured.binding.exportId)
      )
        nativeProjectSave.release(captured.binding.exportId, captured.binding.principal);
      const next = nativeProjectSave.stage(
        {
          target: captured.binding.slot,
          expectedRevision: captured.binding.expectedRevision,
          mode,
        },
        captured.binding.principal,
      );
      const replacement: SaveDialogCapture = {
        project: captured.project,
        binding: {
          ...captured.binding,
          requestId: crypto.randomUUID(),
          exportId: next.id,
          metadata: mode,
        },
      };
      saveDialogRef.current = replacement;
      setSaveDialog(replacement);
      return replacement;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Project Save could not be staged');
    }
  }
  const saveDesignOnly = () => {
    replaceProjectSaveCapture('design');
  };
  const retryProjectSaveRead = async () => {
    const replacement = replaceProjectSaveCapture('auto');
    if (replacement) await resolveProjectSave(replacement);
  };
  async function resolveProjectSave(captured: SaveDialogCapture) {
    if (!captured.binding.exportId)
      return { project: captured.project, files: projectFiles(captured.project) };
    const artifact = await nativeProjectSave.resolve(
        captured.binding.exportId,
        captured.binding.principal,
      ),
      role = artifact.roles.find((entry) => entry.slot === captured.binding.slot);
    if (!role) throw new Error('The captured project Save role is unavailable');
    return role;
  }
  function showLegacyRecordReview(review: DirectoryLegacyReview): boolean {
    if (
      saveDialogRef.current ||
      directoryWriter.getSnapshot().busy ||
      workspaceAuthority.getSnapshot().phase !== 'ready'
    )
      return false;
    const current = useWorkspace.getState();
    const captured: SaveDialogCapture = {
      binding: {
        slot: review.slot,
        expectedRevision: current.documentRevision ?? 0,
        requestId: crypto.randomUUID(),
        principal: (projectSourceContext.current ??= workspaceAuthority.localContext('ui')),
      },
      project: structuredClone(current.documents[review.slot]),
      legacyReview: review,
    };
    saveDialogRef.current = captured;
    setSaveDialog(captured);
    return true;
  }
  modeRef.current = mode;
  const plotRange = plotViews[w.slot][mode].range;
  const setPlotRange = (change: PlotRange | ((range: Readonly<PlotRange>) => PlotRange)) => {
    const current = useWorkspace.getState();
    if (current.slot !== w.slot) throw new Error('The visible plot role changed');
    const context = { slot: current.slot, mode: modeRef.current },
      before = plotController.getSnapshot()[context.slot][context.mode].range;
    if (tabRef.current === 'Input EQ' && context.mode === 'Impulse')
      nativeImpulseView.invalidate([context.slot]);
    plotController.update(context, typeof change === 'function' ? change(before) : change, {
      expectedRange: before,
    });
  };
  const resetPlotRange = () => {
    const context = { slot: useWorkspace.getState().slot, mode: modeRef.current };
    if (tabRef.current === 'Input EQ' && context.mode === 'Impulse')
      nativeImpulseView.invalidate([context.slot]);
    plotController.reset(context);
  };
  const plotChannels = useMemo(
    () => (tab === 'Input EQ' ? [inputEqAnalysisChannel(preset)] : preset.channels),
    [preset, tab],
  );
  const plotPreset = tab === 'Crossover' ? preset : undefined;
  const magnitudeLayers = useMemo(
    () =>
      graphView.currentResult &&
      graphView.otherResults &&
      !graphView.section &&
      !graphView.rawMeasurements.some(Boolean)
        ? undefined
        : {
            rawMeasurements: [...graphView.rawMeasurements],
            currentResult: graphView.currentResult,
            otherResults: graphView.otherResults,
            section: graphView.section,
          },
    [graphView],
  );
  type WorkspaceState = ReturnType<typeof useWorkspace.getState>;
  type GraphSelection = Pick<WorkspaceState, 'slot' | 'preset' | 'channel'>;
  const graphVisible = (requestedTab = tabRef.current, requestedDesigner = designerRef.current) =>
    requestedTab === 'Crossover' && requestedDesigner === 'graph';
  const graphBinding = (selection: GraphSelection) =>
    `${selection.slot}:${projectViewGenerations.current[selection.slot]}:${selection.preset}`;
  const graphContext = (state: WorkspaceState, selection: GraphSelection = state) => {
    const selectedPreset = state.documents[selection.slot]?.presets[selection.preset];
    if (!selectedPreset) throw new Error('Invalid graph preset selection');
    return {
      slot: selection.slot,
      channels: selectedPreset.channels,
      channelIndex: selection.channel,
      binding: graphBinding(selection),
    };
  };
  const commitGraphPlan = (
    plan: GraphViewPlan,
    captured: WorkspaceState,
    selection: GraphSelection = captured,
    choose?: Parameters<WorkspaceState['choose']>[0],
    entry?: { explicitChannelSelection?: boolean },
    nativeWritebackAllowed = entry !== undefined || graphVisible(),
  ) => {
    const assertCurrent = () => {
      const latest = useWorkspace.getState(),
        target =
          latest.documents[selection.slot]?.presets[selection.preset]?.channels[selection.channel];
      if (
        latest.documents !== captured.documents ||
        latest.documentRevision !== captured.documentRevision ||
        latest.slot !== captured.slot ||
        latest.preset !== captured.preset ||
        latest.channel !== captured.channel ||
        latest.filter !== captured.filter ||
        plan.slot !== selection.slot ||
        plan.channelIndex !== selection.channel ||
        plan.binding !== graphBinding(selection) ||
        target?.id !== plan.channelId
      )
        throw new Error('The graph target changed; choose the view again');
      graphController.validate(plan);
      return { latest, target };
    };
    const { latest, target } = assertCurrent();
    const entryPlan = entry
      ? nativeGraphEntries.plan({
          slot: selection.slot,
          presetIndex: selection.preset,
          channelIndex: selection.channel,
          ...entry,
        })
      : undefined;
    const writeback = nativeWritebackAllowed ? plan.writeback : undefined;
    const changesGraph =
      !!writeback &&
      (target.hfdGraph?.showMeasuredResponse !== writeback.showMeasuredResponse ||
        target.hfdGraph?.showSum !== writeback.showSum);
    const publish = (apply?: (document: Project, slot: Slot) => void) => {
      assertCurrent();
      if (entryPlan?.changed || changesGraph)
        latest.editAt(
          [selection.slot],
          (document, slot) => {
            assertCurrent();
            apply?.(document, slot);
            const destination = document.presets[selection.preset].channels[selection.channel];
            if (slot !== selection.slot || destination.id !== plan.channelId)
              throw new Error('The graph output changed');
            if (changesGraph) destination.hfdGraph = { ...writeback! };
          },
          { synchronizeLinks: false },
        );
      if (choose) useWorkspace.getState().choose(choose);
      graphController.commit(plan);
    };
    if (entryPlan) nativeGraphEntries.commit(entryPlan, publish);
    else publish();
  };
  const patchGraph = (patch: GraphViewPatch) => {
    const captured = useWorkspace.getState();
    commitGraphPlan(
      graphController.plan(graphContext(captured), patch),
      captured,
      captured,
      undefined,
      graphVisible() ? {} : undefined,
    );
  };
  const chooseWorkspace = (
    patch: Parameters<WorkspaceState['choose']>[0],
    options?: {
      openGraph?: boolean;
      explicitChannelSelection?: boolean;
      initializeGraph?: boolean;
    },
  ) => {
    const captured = useWorkspace.getState();
    if (!['slot', 'preset', 'channel', 'filter'].some((key) => key in patch)) {
      captured.choose(patch);
      return;
    }
    if (!graphVisible() && !options?.openGraph) {
      captured.choose(patch);
      return;
    }
    const selection = {
      slot: patch.slot ?? captured.slot,
      preset: patch.preset ?? captured.preset,
      channel: patch.channel ?? captured.channel,
    };
    const plan = graphController.selection(graphContext(captured, selection), {
      normalize: options?.initializeGraph !== false,
      ...(patch.filter === undefined ? {} : { selectSection: true }),
    });
    commitGraphPlan(
      plan,
      captured,
      selection,
      patch,
      options?.initializeGraph === false
        ? undefined
        : {
            explicitChannelSelection:
              options?.explicitChannelSelection ?? patch.channel !== undefined,
          },
    );
  };
  const initializeVisibleGraph = (explicitChannelSelection = false) => {
    const current = useWorkspace.getState();
    commitGraphPlan(
      graphController.selection(graphContext(current), { normalize: true }),
      current,
      current,
      undefined,
      { explicitChannelSelection },
    );
  };
  const setWorkspaceTabOnly = (next: typeof tab) => {
    tabRef.current = next;
    setTab(next);
  };
  const setWorkspaceDesignerOnly = (next: typeof designer) => {
    designerRef.current = next;
    setDesigner(next);
  };
  const openWorkspaceTab = (next: typeof tab) => {
    if (graphVisible(next)) initializeVisibleGraph();
    setWorkspaceTabOnly(next);
  };
  const openWorkspaceDesigner = (next: typeof designer) => {
    if (graphVisible(tabRef.current, next)) initializeVisibleGraph();
    setWorkspaceDesignerOnly(next);
  };
  useEffect(() => {
    if (!hydrated || !persistenceStatus.hydrated) return;
    // Restoration is passive. Native's callback normalization is reserved for
    // explicit selection/HFD-preset actions, never hydration or document Undo.
    const current = useWorkspace.getState();
    graphController.commit(graphController.selection(graphContext(current), { normalize: false }));
  }, [
    hydrated,
    persistenceStatus.hydrated,
    w.slot,
    w.preset,
    w.channel,
    channel.id,
    channel.hfdGraph,
    channel.measurement,
    graphView.nativeTracking,
    graphController,
  ]);
  const nativeCenterStatus = hfdCentering(preset.channels, nativeCentered);
  const timeFit = (
    kind: 'response' | 'truncated',
    requestedMode = mode,
    requestedMeasured = measured,
    requestedTab = tab,
    requestedSum = sum,
  ) => {
    if (requestedMode !== 'Impulse' && requestedMode !== 'Step')
      throw new Error('Choose Impulse or Step before fitting a time response');
    const selected = useWorkspace.getState(),
      selectedPreset = selected.documents[selected.slot].presets[selected.preset];
    const eq = requestedTab === 'Input EQ';
    const analysis = analyzeTimeResponses(
      eq ? [inputEqAnalysisChannel(selectedPreset)] : selectedPreset.channels,
      {
        preset: eq ? undefined : selectedPreset,
        measured: requestedMeasured && !eq,
        sum: requestedSum && !eq,
        referenceChannel: eq ? 0 : selected.channel,
      },
    );
    const curves = [...analysis.channels, ...(requestedSum && analysis.sum ? [analysis.sum] : [])];
    const series = curves.flatMap((c) => {
      const value = requestedMode === 'Step' ? c.step : c.impulse;
      return value ? [value] : [];
    });
    if (!series.length) throw new Error('Load an impulse response to fit the measured time view.');
    if (kind === 'truncated' && !analysis.windowBounds)
      throw new Error('No measured impulse window is available.');
    return fitTimeSeries(series, kind === 'truncated' ? analysis.windowBounds : undefined);
  };
  const restoreNativeImpulse = () => {
    const result = nativeImpulseView.restore();
    const current = useWorkspace.getState();
    const selected =
      current.documents[current.slot].presets[current.preset].channels[current.channel];
    const previous = plotController.getSnapshot()[current.slot].Impulse.range;
    if (result.changed && !projectNativeImpulseZoom(selected.hfdImpulseZoom, previous)) {
      let automatic: Partial<PlotRange>;
      try {
        const display = graphController.getSnapshot()[current.slot];
        automatic = timeFit('response', 'Impulse', display.measured, 'Crossover', display.sum);
      } catch {
        const defaults = defaultPlotRange('Impulse');
        automatic = {
          timeMinMs: defaults.timeMinMs,
          timeMaxMs: defaults.timeMaxMs,
          amplitudeMin: defaults.amplitudeMin,
          amplitudeMax: defaults.amplitudeMax,
        };
      }
      plotController.restore(
        { slot: current.slot, mode: 'Impulse' },
        { ...previous, ...automatic },
      );
    }
    return result;
  };
  function projectViewsReplaced(slots: readonly Slot[]) {
    nativeGraphEntries.invalidateRoles(slots);
    for (const slot of slots) projectViewGenerations.current[slot]++;
    for (const [key, view] of retainedHardwareGainViews.current)
      if (slots.includes(view.slot)) retainedHardwareGainViews.current.delete(key);
    setDocumentEpochs((previous) => ({
      left: previous.left + Number(slots.includes('left')),
      right: previous.right + Number(slots.includes('right')),
    }));
    nativeImpulseView.invalidate(slots);
    const current = useWorkspace.getState();
    refreshPhaseMeasurements(slots, current.preset, [current.channel]);
    if (slots.includes(current.slot) && graphVisible()) {
      // File replacement initializes only the graph actually visible here.
      // Retain the imported selected-group metadata, including native -1.
      initializeVisibleGraph();
    }
    if (
      slots.includes(useWorkspace.getState().slot) &&
      modeRef.current === 'Impulse' &&
      tabRef.current === 'Crossover'
    )
      restoreNativeImpulse();
  }
  function refreshPhaseMeasurements(
    slots: readonly Slot[],
    presetIndex: number,
    channelIndexes: readonly number[],
  ) {
    const current = useWorkspace.getState();
    if (
      !slots.includes(current.slot) ||
      current.preset !== presetIndex ||
      !channelIndexes.includes(current.channel)
    )
      return;
    try {
      commitGraphPlan(
        graphController.selection(graphContext(current), { normalize: false, refreshPhase: true }),
        current,
      );
    } catch (error) {
      setError(
        `Measurement changed; phase view refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const captureNativeRangeBinding = () => {
    if (useWorkspace.getState().gesture)
      throw new Error('Finish the current graph edit before saving the Impulse view');
    return nativeImpulseView.capture();
  };
  const saveTimeRange = (change: PlotRange | ((range: Readonly<PlotRange>) => PlotRange)) => {
    const binding =
      modeRef.current === 'Impulse' && tabRef.current === 'Crossover'
        ? captureNativeRangeBinding()
        : undefined;
    setPlotRange(change);
    if (binding) nativeImpulseView.commit(binding);
  };
  const fitTime = (
    kind: 'response' | 'truncated',
    requestedMode = modeRef.current,
    requestedMeasured = measured,
    requestedTab = tab,
    requestedSum = sum,
    saveNative = true,
  ) => {
    const binding =
      saveNative && requestedMode === 'Impulse' && requestedTab === 'Crossover'
        ? captureNativeRangeBinding()
        : undefined;
    const context = { slot: useWorkspace.getState().slot, mode: requestedMode };
    if (requestedTab === 'Input EQ' && requestedMode === 'Impulse')
      nativeImpulseView.invalidate([context.slot]);
    plotController.update(
      context,
      timeFit(kind, requestedMode, requestedMeasured, requestedTab, requestedSum),
      { clearHistory: true },
    );
    if (binding) nativeImpulseView.commit(binding);
  };
  const choosePlotMode = (next: PlotMode) => {
    modeRef.current = next;
    setMode(next);
    if (next === 'Impulse' && tab === 'Crossover') {
      designAction(() => {
        restoreNativeImpulse();
      }, 'Impulse view restored.');
      return;
    }
    if (
      (next === 'Impulse' || next === 'Step') &&
      !plotController.getSnapshot()[useWorkspace.getState().slot][next].touched
    )
      designAction(
        () => fitTime('response', next, measured, tab, sum, false),
        `${next} view fitted.`,
      );
  };
  useEffect(() => {
    if (hydrated && persistenceStatus.hydrated && tab === 'Crossover' && mode === 'Impulse')
      restoreNativeImpulse();
  }, [
    hydrated,
    persistenceStatus.hydrated,
    tab,
    mode,
    w.slot,
    w.preset,
    w.channel,
    channel.id,
    w.documents[w.slot],
    measured,
    sum,
    nativeImpulseView,
    plotController,
  ]);
  const inspector = useRef<HTMLFieldSetElement>(null);
  const inspectorDetails = useRef<HTMLDivElement>(null);
  const eqClipboard = useRef<EqBank | undefined>(undefined);
  const file = useRef<HTMLInputElement>(null),
    pendingFile = useRef<((text: string, name: string) => void) | null>(null),
    liveRef = useRef(live);
  liveRef.current = live;
  const firmwareAssignments = useRef<Partial<Record<Slot, FirmwareAssignmentLease>>>({});
  const firmwareAssignmentEpoch = useRef(0);
  const firmwareCandidates = useRef<
    Partial<
      Record<
        Slot,
        {
          key: string;
          serial?: string;
          device: HIDDevice;
          session: PanelSession;
        }
      >
    >
  >({});
  const firmwareRemembered = useRef<
    Partial<
      Record<
        Slot,
        {
          key: string;
          serial: string;
          device: HIDDevice;
        }
      >
    >
  >({});
  const nativeProjectSave = useMemo(
    () =>
      createNativeProjectSaveController({
        state: useWorkspace.getState,
        binding: (slot) => liveRef.current[slot],
        operate,
      }),
    [],
  );
  nativeSaveRef.current = nativeProjectSave;
  const nativeSaveSnapshot = useSyncExternalStore(
    nativeProjectSave.subscribe,
    nativeProjectSave.getSnapshot,
    nativeProjectSave.getSnapshot,
  );
  const nativeSaveLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++nativeSaveLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (nativeSaveLifetime.current === lifetime) nativeProjectSave.dispose();
      });
    };
  }, [nativeProjectSave]);
  const saveCapture = nativeSaveSnapshot.captures.find(
      (capture) => capture.id === saveDialog?.binding.exportId,
    ),
    saveCaptureRole = saveCapture?.roles.find((role) => role.slot === saveDialog?.binding.slot);
  const noiseController = useMemo(
    () => createNoiseController({ connections: () => liveRef.current, operate }),
    [],
  );
  const deviceAuth = useMemo(
    () =>
      createDeviceAuthController({
        binding: (slot) => {
          const connection = liveRef.current[slot];
          return connection
            ? {
                session: connection.session,
                identity: {
                  serial: connection.identity.serial,
                  product: connection.identity.product,
                  core: connection.identity.core,
                  firmware: connection.identity.firmware,
                },
              }
            : undefined;
        },
      }),
    [],
  );
  const deviceDefaults = useMemo(
    () => createDeviceDefaultsController({ binding: (slot) => liveRef.current[slot], operate }),
    [],
  );
  const defaultsSnapshot = useSyncExternalStore(
    deviceDefaults.subscribe,
    deviceDefaults.getSnapshot,
    deviceDefaults.getSnapshot,
  );
  const cloneWorkspace = useMemo(
    () =>
      createCloneWorkspace({
        state: () => useWorkspace.getState(),
        edit: (slots, change, options) => useWorkspace.getState().editAt(slots, change, options),
      }),
    [],
  );
  const deviceClone = useMemo(
    () =>
      createDeviceCloneController({
        binding: (slot) => liveRef.current[slot],
        design: cloneWorkspace.design,
        replaceTemplates: cloneWorkspace.replaceTemplates,
        operate,
      }),
    [cloneWorkspace],
  );
  const cloneSnapshot = useSyncExternalStore(
    deviceClone.subscribe,
    deviceClone.getSnapshot,
    deviceClone.getSnapshot,
  );
  const cloneLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++cloneLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (cloneLifetime.current === lifetime) deviceClone.dispose();
      });
    };
  }, [deviceClone]);
  const amplifierModes = useMemo(
    () =>
      createAmplifierModesController({
        binding: (slot) => liveRef.current[slot],
        operate,
        onStatus: (slot, session, status) => {
          const current = liveRef.current[slot];
          if (!current || current.session !== session) return;
          const next = { ...liveRef.current, [slot]: { ...current, status } };
          liveRef.current = next;
          setLive(next);
        },
      }),
    [],
  );
  const modesSnapshot = useSyncExternalStore(
    amplifierModes.subscribe,
    amplifierModes.getSnapshot,
    amplifierModes.getSnapshot,
  );
  const modesLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++modesLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (modesLifetime.current === lifetime) amplifierModes.dispose();
      });
    };
  }, [amplifierModes]);
  const nativeLimiter = useMemo(
    () => createNativeLimiterController({ binding: (slot) => liveRef.current[slot], operate }),
    [],
  );
  const nativeLimiterSnapshot = useSyncExternalStore(
    nativeLimiter.subscribe,
    nativeLimiter.getSnapshot,
    nativeLimiter.getSnapshot,
  );
  const limiterLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++limiterLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (limiterLifetime.current === lifetime) nativeLimiter.dispose();
      });
    };
  }, [nativeLimiter]);
  const nativeMixer = useMemo(
    () => createNativeMixerController({ binding: (slot) => liveRef.current[slot], operate }),
    [],
  );
  const nativeMixerSnapshot = useSyncExternalStore(
    nativeMixer.subscribe,
    nativeMixer.getSnapshot,
    nativeMixer.getSnapshot,
  );
  const mixerLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++mixerLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (mixerLifetime.current === lifetime) nativeMixer.dispose();
      });
    };
  }, [nativeMixer]);
  const defaultsLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++defaultsLifetime.current;
    return () => {
      queueMicrotask(() => {
        if (defaultsLifetime.current === lifetime) deviceDefaults.dispose();
      });
    };
  }, [deviceDefaults]);
  const lastDefaultsResult = [...defaultsSnapshot.records]
    .reverse()
    .find(
      (record) =>
        ['complete', 'partial', 'failed'].includes(record.phase) &&
        record.roles.some((role) => role.slot === w.slot),
    );
  const shownDefaultsResults = useRef(new Set<string>());
  useEffect(() => {
    if (defaultsSnapshot.busy) return;
    const next = { ...liveRef.current };
    let changed = false;
    for (const record of defaultsSnapshot.records) {
      if (!['complete', 'partial', 'failed'].includes(record.phase)) continue;
      const resultKey = `${record.id}:${record.updatedAt}:${record.phase}`;
      if (shownDefaultsResults.current.has(resultKey)) continue;
      shownDefaultsResults.current.add(resultKey);
      for (const role of record.roles) {
        const connection = next[role.slot],
          confirmed = connection?.session.lastStatus;
        if (
          !connection ||
          !confirmed ||
          connection.identity.serial !== role.identity.serial ||
          connection.identity.product !== role.identity.product ||
          connection.identity.core !== role.identity.core ||
          connection.identity.firmware !== role.identity.firmware
        )
          continue;
        next[role.slot] = { ...connection, status: structuredClone(confirmed) };
        changed = true;
      }
    }
    if (changed) {
      liveRef.current = next;
      setLive(next);
    }
  }, [defaultsSnapshot.records, defaultsSnapshot.busy]);
  const shownLimiterResult = useRef<string | undefined>(undefined);
  useEffect(() => {
    const result = nativeLimiterSnapshot.lastResult;
    if (nativeLimiterSnapshot.busy || !result || shownLimiterResult.current === result.reviewId)
      return;
    shownLimiterResult.current = result.reviewId;
    const next = { ...liveRef.current };
    let changed = false;
    for (const role of result.roles) {
      const connection = next[role.slot],
        confirmed = connection?.session.lastStatus;
      if (
        !connection ||
        !confirmed ||
        connection.identity.serial !== role.identity.serial ||
        connection.identity.product !== role.identity.product ||
        connection.identity.core !== role.identity.core ||
        connection.identity.firmware !== role.identity.firmware
      )
        continue;
      next[role.slot] = { ...connection, status: structuredClone(confirmed) };
      changed = true;
    }
    if (changed) {
      liveRef.current = next;
      setLive(next);
    }
  }, [nativeLimiterSnapshot.lastResult, nativeLimiterSnapshot.busy]);
  const descriptorVerifier = useMemo(
    () =>
      createUsbDescriptorVerifier({
        binding: (slot) => {
          const identity = liveRef.current[slot]?.identity;
          return identity
            ? {
                serial: identity.serial,
                product: identity.product,
                core: identity.core,
                firmware: identity.firmware,
              }
            : undefined;
        },
      }),
    [],
  );
  const firmwareWorkspace = useMemo(
    () =>
      createFirmwareWorkspace({
        assignmentId: (slot) => firmwareAssignments.current[slot]?.assignmentId,
        descriptor: (slot) => descriptorVerifier.getSnapshot()[slot].proof,
        binding: (slot) => {
          const identity = liveRef.current[slot]?.identity;
          return identity
            ? {
                serial: identity.serial,
                core: identity.core,
                firmware: identity.firmware,
                product: identity.product,
              }
            : undefined;
        },
      }),
    [descriptorVerifier],
  );
  const firmwareExecution = useMemo(() => {
    let workflow: FirmwareExecutionWorkflow;
    const binding = (slot: Slot): FirmwareJournalBinding | undefined => {
      const lease = firmwareAssignments.current[slot],
        connection = liveRef.current[slot],
        proof = descriptorVerifier.getSnapshot()[slot].proof;
      if (
        !lease ||
        !connection ||
        connection.connectionId !== lease.connectionId ||
        connection.identity.serial !== lease.serial ||
        !proof ||
        proof.family !== 'FUSION32' ||
        JSON.stringify(proof.binding) !==
          JSON.stringify({
            serial: connection.identity.serial,
            product: connection.identity.product,
            core: connection.identity.core,
            firmware: connection.identity.firmware,
          })
      )
        return undefined;
      return {
        assignmentId: lease.assignmentId,
        connectionId: lease.connectionId,
        connectionEpoch: lease.connectionEpoch,
        serial: lease.serial,
        hidSerial: proof.hidSerial,
        family: proof.family,
        product: connection.identity.product,
        core: connection.identity.core,
        firmware: connection.identity.firmware,
      };
    };
    const coordinator = createFirmwareUpdateCoordinator({
      adapter: createFirmwareWebHidUpdateAdapter({
        capture: (captured) => {
          const current = binding(capturedSlot(captured));
          if (!current || JSON.stringify(current) !== JSON.stringify(captured)) return undefined;
          const slot = capturedSlot(captured),
            connection = liveRef.current[slot]!;
          return {
            binding: current,
            device: connection.device,
            session: connection.session,
            descriptor: descriptorVerifier.getSnapshot()[slot].proof,
          };
        },
        isCurrent: (captured) =>
          Object.values(firmwareAssignments.current).some(
            (lease) =>
              lease.assignmentId === captured.assignmentId && lease.serial === captured.serial,
          ),
        assignedDevices: () =>
          Object.values(liveRef.current).map((connection) => connection.device),
        onRuntimeRetired: (captured) => {
          const slot = SLOTS.find(
            (role) => firmwareAssignments.current[role]?.assignmentId === captured.assignmentId,
          );
          if (!slot || liveRef.current[slot]?.connectionId !== captured.connectionId) return;
          const next = { ...liveRef.current };
          delete next[slot];
          liveRef.current = next;
          setLive(next);
          descriptorVerifier.clear(slot);
          deviceAuth.clear(slot);
        },
      }),
      binding,
      prepareRecovery: (roles) => {
        const planned = planFirmwareRecoveryAssignments(
          firmwareAssignments.current,
          Object.fromEntries(
            Object.entries(liveRef.current).map(([slot, connection]) => [
              slot,
              connection.identity.serial,
            ]),
          ),
          roles,
        );
        // Validate all roles before publishing this metadata map. No interface
        // is opened or claimed, and the historical bindings remain unchanged.
        firmwareAssignments.current = planned;
        firmwareAssignmentEpoch.current = Math.max(
          firmwareAssignmentEpoch.current,
          ...roles.map((role) => role.binding.connectionEpoch),
        );
        workflow.refreshContext();
      },
      assignmentId: (slot) => firmwareAssignments.current[slot]?.assignmentId,
      source: (slot) => {
        const id = firmwareWorkspace.getSnapshot()[slot].stage?.id;
        return id ? firmwareWorkspace.executionSource(slot, id) : undefined;
      },
    });
    function capturedSlot(captured: Readonly<FirmwareJournalBinding>): Slot {
      const slot = SLOTS.find(
        (role) => firmwareAssignments.current[role]?.assignmentId === captured.assignmentId,
      );
      if (!slot) throw new Error('Firmware role assignment changed');
      return slot;
    }
    workflow = createFirmwareExecutionWorkflow({
      workspace: firmwareWorkspace,
      coordinator,
      assignmentId: (slot) => firmwareAssignments.current[slot]?.assignmentId,
    });
    return workflow;
  }, [firmwareWorkspace, descriptorVerifier]);
  const firmwareExecutionLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++firmwareExecutionLifetime.current;
    return () =>
      queueMicrotask(() => {
        if (firmwareExecutionLifetime.current === lifetime) firmwareExecution.dispose();
      });
  }, [firmwareExecution]);
  const firmwareRuntime = useMemo(
    () =>
      createFirmwareRuntimeController(
        createFirmwareRuntimeSourceProvider({
          live: (slot) => {
            const connection = liveRef.current[slot];
            return connection
              ? {
                  key: connection.connectionId,
                  serial: connection.identity.serial,
                  device: connection.device,
                  session: connection.session,
                }
              : undefined;
          },
          candidate: (slot) => firmwareCandidates.current[slot],
          remembered: (slot) => firmwareRemembered.current[slot],
          allLive: () => Object.values(liveRef.current),
          operate,
        }),
      ),
    [],
  );
  const firmwareRuntimeSnapshot = useSyncExternalStore(
    firmwareRuntime.subscribe,
    firmwareRuntime.getSnapshot,
    firmwareRuntime.getSnapshot,
  );
  const firmwareRuntimeLifetime = useRef(0);
  useEffect(() => {
    const lifetime = ++firmwareRuntimeLifetime.current;
    return () =>
      queueMicrotask(() => {
        if (firmwareRuntimeLifetime.current === lifetime) firmwareRuntime.dispose();
      });
  }, [firmwareRuntime]);
  useEffect(() => {
    descriptorVerifier.refreshBindings();
    deviceAuth.refreshBindings();
    deviceDefaults.refreshBindings();
    deviceClone.refreshBindings();
    amplifierModes.refreshBindings();
    nativeLimiter.refreshBindings();
    nativeMixer.refreshBindings();
    firmwareRuntime.refreshBindings();
    firmwareExecution.refreshContext();
    noiseController.refreshBindings();
  }, [
    live,
    w.documentRevision,
    descriptorVerifier,
    deviceAuth,
    deviceDefaults,
    deviceClone,
    amplifierModes,
    nativeLimiter,
    nativeMixer,
    firmwareRuntime,
    firmwareExecution,
    noiseController,
  ]);
  const revealInspector = () => {
    setShowRaw(false);
    inspector.current?.scrollTo({ top: 0 });
    inspectorDetails.current?.scrollTo({ top: 0 });
  };
  const selectFilter = (index: number) => {
    revealInspector();
    if (tab === 'Input EQ') setEqIndex(Math.min(8, index));
    else chooseWorkspace({ filter: index });
  };
  useEffect(revealInspector, [
    w.slot,
    w.preset,
    w.channel,
    w.filter,
    eqIndex,
    tab,
    tab === 'Input EQ' ? preset.inputEq[eqIndex]?.kind : channel.filters[w.filter]?.kind,
  ]);
  useEffect(() => {
    setSelectedBiquads([useWorkspace.getState().filter]);
  }, [w.slot, w.preset, w.channel]);
  useEffect(() => {
    setCopySourceChannel(null);
  }, [w.slot, w.preset]);
  const selectChain = (ch: number, index: number, multiple: boolean) => {
    revealInspector();
    setSelectedBiquads((old) =>
      multiple && ch === w.channel
        ? old.includes(index)
          ? old.filter((i) => i !== index)
          : [...old, index]
        : [index],
    );
    chooseWorkspace({ channel: ch, filter: index });
  };
  const designAction = (action: () => void, message: string) => {
    try {
      action();
      setError('');
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const operationActive = useRef(false);
  const readFile = (accept: string, fn: (text: string, name: string) => void) => {
    pendingFile.current = fn;
    file.current!.accept = accept;
    file.current!.value = '';
    file.current!.click();
  };
  async function operate<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (operationActive.current) throw new Error('Another operation is still running');
    operationActive.current = true;
    setBusy(label);
    setError('');
    setUploadReport([]);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ProjectUploadError || e instanceof EqBankUploadError)
        setUploadReport(e.results);
      throw e;
    } finally {
      operationActive.current = false;
      setBusy('');
      setBackups(await listBackups().catch(() => []));
    }
  }
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await operate(label, fn);
    } catch {
      /* Error is displayed by the shared operation handler. */
    }
  };
  useEffect(() => {
    if (authorityStatus.phase !== 'ready') return;
    const context = workspaceAuthority.localContext('ui');
    let audioConfig;
    try {
      audioConfig = loadCapturePreferences(window.localStorage);
    } catch (e) {
      setError(
        `Audio preferences could not be loaded: ${e instanceof Error ? e.message : String(e)}. Audio setup can replace them.`,
      );
    }
    const controller = createCaptureController({
      backend: createBrowserCaptureBackend(),
      localOwner: context.owner,
      config: audioConfig,
      saveConfig: (config) => saveCapturePreferences(window.localStorage, config),
      onMeasurementReplaced: (target) =>
        refreshPhaseMeasurements([target.slot], target.preset, [target.channel]),
      workspace: {
        state: useWorkspace.getState,
        flush: flushWorkspacePersistence,
        commit: (...args) => useWorkspace.getState().commitFileImport(...args),
        lookup: (id, owner) => useWorkspace.getState().lookupFileCommit(id, owner),
      },
      operate,
    });
    setAudioAccess({ controller, context });
    const leave = () => {
      void controller.disable(context).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      void controller.dispose().catch(() => {});
      setAudioAccess((current) => (current?.controller === controller ? undefined : current));
    };
  }, [workspaceAuthority, authorityStatus.phase]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const status = getWorkspacePersistenceStatus();
      if (!status.unsaved && !status.saving) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    setHydrated(true);
    listBackups()
      .then(setBackups)
      .catch(() => {});
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      Object.entries(liveRef.current).forEach(([slot, connection]) => {
        void noiseController
          .stopOwned(slot as Slot)
          .catch(() => {})
          .finally(() => connection.session.close().catch(() => {}));
      });
      SLOTS.forEach((slot) => descriptorVerifier.clear(slot));
      // Invalidate ephemeral state without permanently disposing a memoized
      // controller that React may reuse during its development effect replay.
      SLOTS.forEach((slot) => deviceAuth.clear(slot));
    };
  }, []);
  useEffect(() => {
    // A refreshed workspace module owns a new persistence controller. Hydrate
    // it too, without rerunning the USB/listener teardown in the mount effect.
    void ensureWorkspaceHydrated().catch(() => {});
  }, [ensureWorkspaceHydrated]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        for (const slot of SLOTS) {
          const l = liveRef.current[slot];
          if (!l || l.session.busy || busy) continue;
          l.session
            .status()
            .then((status) =>
              setLive((old) =>
                old[slot]?.session === l.session ? { ...old, [slot]: { ...l, status } } : old,
              ),
            )
            .catch((e) => {
              if (liveRef.current[slot]?.session !== l.session) return;
              descriptorVerifier.clear(slot);
              deviceAuth.clear(slot);
              setError(`${slot}: ${e.message}`);
              setLive((old) => {
                if (old[slot]?.session !== l.session) return old;
                const next = { ...old };
                delete next[slot];
                return next;
              });
              void l.session.close().catch(() => {});
            });
        }
      },
      showMeters ? 250 : 2000,
    );
    return () => clearInterval(timer);
  }, [busy, showMeters]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setWorkspaceTabOnly('Help');
        return;
      }
      if (!getWorkspacePersistenceStatus().hydrated) {
        if ((e.ctrlKey || e.metaKey) && ['s', 'z'].includes(e.key.toLowerCase()))
          e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        openProjectSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (w.gesture) w.endGesture();
        e.shiftKey ? w.redo() : w.undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project, w]);
  async function requestConnection(slot: Slot, serial?: string) {
    if (liveRef.current[slot])
      throw new Error(`Disconnect the ${slot} amplifier before assigning another device.`);
    // Keep requestDevice on the immediate user-activation call stack.
    if (!('hid' in navigator))
      throw new Error(
        'WebHID requires desktop Chrome or Edge. Open this page in a top-level browser tab.',
      );
    const selected = serial
      ? await navigator.hid.getDevices()
      : await navigator.hid.requestDevice({
          filters: [{ vendorId: VID, productId: PID, usagePage: 0xff00, usage: 1 }],
        });
    if (!selected.length)
      throw new Error(
        serial
          ? 'No previously permitted amplifier found. Use Connect once to grant browser access.'
          : 'No amplifier selected',
      );
    delete firmwareAssignments.current[slot];
    firmwareExecution.refreshContext();
    await operate(`Connecting ${slot}`, async () => {
      if (liveRef.current[slot])
        throw new Error(`The ${slot} amplifier role was assigned while choosing a device.`);
      for (const device of selected) {
        if (
          device.vendorId !== VID ||
          device.productId !== PID ||
          device.opened ||
          Object.values(liveRef.current).some((l) => l.device === device)
        )
          continue;
        await device.open();
        const session = new PanelSession(new WebHidTransport(device), saveBackup);
        try {
          const identity = await session.identify();
          if (serial && identity.serial !== serial) {
            await session.close();
            continue;
          }
          const status = await session.status();
          if (Object.values(liveRef.current).some((l) => l.identity.serial === identity.serial))
            throw new Error('This serial is already assigned to the other role');
          const next = {
            ...liveRef.current,
            [slot]: { session, identity, status, device, connectionId: crypto.randomUUID() },
          };
          firmwareAssignments.current[slot] = {
            assignmentId: crypto.randomUUID(),
            connectionId: next[slot]!.connectionId,
            connectionEpoch: ++firmwareAssignmentEpoch.current,
            serial: identity.serial,
          };
          firmwareRemembered.current[slot] = {
            key: crypto.randomUUID(),
            serial: identity.serial,
            device,
          };
          descriptorVerifier.clear(slot);
          deviceAuth.clear(slot);
          liveRef.current = next;
          setLive(next);
          setNotice(
            `${slot === 'left' ? 'Left' : 'Right'} connected · ${identity.name || 'FA503'}`,
          );
          return;
        } catch (e) {
          // A recognized newer runtime can be identified without admitting it
          // to the ordinary controls dialect. The selected/previously-permitted
          // interface is already owned by this Connecting operation.
          if (e instanceof UnsupportedPanelRuntimeError) {
            const candidate = {
              key: crypto.randomUUID(),
              ...(serial ? { serial } : {}),
              device,
              session,
            };
            firmwareCandidates.current[slot] = candidate;
            try {
              const result = await firmwareRuntime.read(
                slot,
                workspaceAuthority.localContext('manual'),
              );
              const report = result.roles[slot].report;
              if (report) {
                if (
                  Object.entries(liveRef.current).some(
                    ([role, connection]) =>
                      role !== slot && connection.identity.serial === report.identity.serial,
                  )
                )
                  throw new Error('This serial is already assigned to the other role');
                firmwareRemembered.current[slot] = {
                  key: crypto.randomUUID(),
                  serial: report.identity.serial,
                  device,
                };
                if (!report.controlsQualified) {
                  setWorkspaceTabOnly('Device settings');
                  chooseWorkspace({ slot });
                  throw new FirmwareRuntimeDiagnosticError(
                    `Firmware ${report.identity.firmware} / DSP core ${report.identity.core} identified read-only. Controls for this runtime are unavailable.`,
                    report,
                  );
                }
              }
            } catch (diagnostic) {
              if (diagnostic instanceof FirmwareRuntimeDiagnosticError) {
                await session.close();
                throw diagnostic;
              }
              if (diagnostic instanceof FirmwareRuntimeSerialMismatchError) {
                await session.close();
                continue;
              }
              // Preserve the original controls-admission refusal if the narrow
              // diagnostic reader could not establish a complete identity.
            } finally {
              if (firmwareCandidates.current[slot]?.key === candidate.key)
                delete firmwareCandidates.current[slot];
              firmwareRuntime.refreshBindings();
            }
          }
          await session.close();
          throw e;
        }
      }
      throw new Error('The requested amplifier is unavailable or already assigned');
    });
  }
  const connect = (slot: Slot) => requestConnection(slot).catch((e) => setError(String(e)));
  async function controls(patch: Controls) {
    await run('Updating controls', async () => {
      const selected = live[w.slot];
      if (!selected) throw new Error('Connect the selected amplifier first');
      const linkable = Object.keys(patch).every((k) => ['volume', 'mute', 'preset'].includes(k));
      const targets = w.linkedControls && linkable ? SLOTS.filter((s) => live[s]) : [w.slot];
      const delta =
        patch.volume !== undefined ? patch.volume - (await selected.session.status()).volume : 0;
      const prepared = await Promise.all(
        targets.map(async (slot) => {
          const connection = live[slot]!;
          const preparedPatch: Controls = {
            ...patch,
            ...(patch.volume !== undefined
              ? {
                  volume:
                    slot === w.slot
                      ? patch.volume
                      : Math.max(
                          -96,
                          Math.min(18, (await connection.session.status()).volume + delta),
                        ),
                }
              : {}),
          };
          return { slot, connection, patch: preparedPatch };
        }),
      );
      // Validate every destination and its final patch before any write or recovery mute.
      const preflight = await Promise.allSettled(
        prepared.map(async ({ slot, connection, patch }) => {
          try {
            await connection.session.preflightControls(patch);
          } catch (error) {
            throw new Error(`${slot}: ${String(error)}`);
          }
        }),
      );
      const denied = preflight.filter((result) => result.status === 'rejected');
      if (denied.length) throw new Error(denied.map((result) => String(result.reason)).join('; '));
      const results = await Promise.allSettled(
        prepared.map(async ({ slot, connection, patch }) => {
          const status = await connection.session.setControls(patch);
          setLive((old) =>
            old[slot]?.session === connection.session
              ? { ...old, [slot]: { ...old[slot]!, status } }
              : old,
          );
        }),
      );
      if (results.some((r) => r.status === 'rejected')) {
        await Promise.allSettled(
          prepared.map(({ connection }) => connection.session.setControls({ mute: true })),
        );
        throw new Error(
          results
            .filter((r) => r.status === 'rejected')
            .map((r) => String(r.reason))
            .join('; '),
        );
      }
      setNotice(`${targets.length === 2 ? 'Both amplifiers' : 'Amplifier'} updated`);
    });
  }
  async function readPanel() {
    await run('Reading filters', async () => {
      const l = live[w.slot];
      if (!l) throw new Error('Connect the selected amplifier');
      const result = await l.session.readPreset(w.preset + 1);
      w.edit((p) => {
        p.presets[w.preset].channels = result.channels;
        p.name = result.backup.name || 'Read from amplifier';
      }, false);
      setNotice('Read all 45 biquads and delays. Exact original sector saved in Backups.');
    });
  }
  async function upload(both = false) {
    await run(both ? 'Uploading stereo pair' : 'Uploading preset', async () => {
      const slots: Slot[] = both ? ['left', 'right'] : [w.slot];
      if (slots.some((s) => !live[s]))
        throw new Error('Connect a distinct amplifier to each selected role');
      const warnings = uploadFirWarnings.filter(
        (warning) => slots.includes(warning.slot) && warning.preset === w.preset + 1,
      );
      if (warnings.length)
        setNotice(
          warnings
            .map((warning) => `${warning.slot} · Preset ${warning.preset}: ${warning.message}`)
            .join(' '),
        );
      setProgress({});
      await uploadPair(
        slots.map((slot) => ({
          session: live[slot]!.session,
          preset: w.preset + 1,
          name: w.documents[slot].name,
          design: w.documents[slot].presets[w.preset],
          progress: (percent, message) =>
            setProgress((old) => ({ ...old, [slot]: { percent, message } })),
        })),
      );
      setNotice(
        `${both ? 'Both amplifiers' : 'Preset'} programmed and read back. Outputs remain muted.`,
      );
      for (const slot of slots) {
        const l = live[slot]!;
        const identity = await l.session.identify(),
          status = await l.session.status();
        setLive((old) => ({ ...old, [slot]: { ...l, identity, status } }));
      }
    });
  }
  async function uploadAll(both = false) {
    await run('Uploading all crossover presets', async () => {
      const slots: Slot[] = both ? ['left', 'right'] : [w.slot];
      if (slots.some((slot) => !live[slot]))
        throw new Error('Connect a distinct amplifier to each selected role');
      const warnings = uploadFirWarnings.filter((warning) => slots.includes(warning.slot));
      if (warnings.length)
        setNotice(
          warnings
            .map((warning) => `${warning.slot} · Preset ${warning.preset}: ${warning.message}`)
            .join(' '),
        );
      setProgress({});
      await uploadProjectPair(
        slots.map((slot) => ({
          session: live[slot]!.session,
          name: w.documents[slot].name,
          presets: w.documents[slot].presets,
          label: slot,
          progress: (percent, message) =>
            setProgress((old) => ({ ...old, [slot]: { percent, message } })),
        })),
      );
      await adapter.refresh(slots);
      setNotice(
        'All three crossover presets verified. Starting active preset restored; outputs remain muted. Input EQ is separate.',
      );
    });
  }
  const beginNumericGesture = (): NumericFocusOperation => {
    const current = useWorkspace.getState();
    if (
      current.documents !== w.documents ||
      current.slot !== w.slot ||
      current.preset !== w.preset ||
      current.channel !== w.channel ||
      current.filter !== w.filter ||
      current.linkedEdits !== w.linkedEdits
    )
      throw new Error('The numeric editing context changed before focus');
    const token = current.beginFieldGesture();
    return {
      isCurrent: () => {
        const latest = useWorkspace.getState();
        return (
          latest.isFieldGestureCurrent(token) &&
          latest.slot === current.slot &&
          latest.preset === current.preset &&
          latest.channel === current.channel &&
          latest.filter === current.filter &&
          latest.linkedEdits === current.linkedEdits
        );
      },
      run: (action) => useWorkspace.getState().runFieldGesture(token, action),
      end: (cancel) => useWorkspace.getState().endFieldGesture(token, cancel),
    };
  };
  const hardwareGainViewKey = (location: Omit<HardwareGainEditorLocation, 'channelId'>) =>
    `${location.slot}:${documentEpochs[location.slot]}:${location.presetIndex}:${location.channelIndex}`;
  const getHardwareGainContext: NonNullable<ToolAdapter['hardwareGainContext']> = (location) => {
    const current = useWorkspace.getState();
    if (
      !SLOTS.includes(location.slot) ||
      ![location.presetIndex, location.channelIndex].every(
        (index) => Number.isInteger(index) && index >= 0 && index < 3,
      )
    )
      return undefined;
    const c =
      current.documents[location.slot].presets[location.presetIndex].channels[
        location.channelIndex
      ];
    let presentation;
    try {
      presentation = hardwareGainPresentation(c);
    } catch {
      return undefined;
    }
    const retained = retainedHardwareGainViews.current.get(hardwareGainViewKey(location));
    if (retained?.channelId !== c.id && !presentation.available) return undefined;
    const active =
      current.slot === location.slot &&
      current.preset === location.presetIndex &&
      current.channel === location.channelIndex &&
      w.slot === current.slot &&
      w.preset === current.preset &&
      w.channel === current.channel &&
      channel.id === c.id &&
      Object.is(channel.gain, c.gain) &&
      Object.is(channel.additionalGain, c.additionalGain);
    const expectedField = `${location.slot}:${documentEpochs[location.slot]}:${location.presetIndex}:${c.id}`;
    const field =
      active && hardwareGainInput.current?.dataset.channelGainContext === expectedField
        ? hardwareGainInput.current.querySelector('input')
        : undefined;
    return { available: true, gainText: field?.value ?? presentation.gainText };
  };
  const retainHardwareGainContexts: NonNullable<ToolAdapter['retainHardwareGainContexts']> = (
    locations,
  ) => {
    const current = useWorkspace.getState();
    const keys = locations.map((location) => {
      if (
        !SLOTS.includes(location.slot) ||
        ![location.presetIndex, location.channelIndex].every(
          (index) => Number.isInteger(index) && index >= 0 && index < 3,
        ) ||
        current.documents[location.slot].presets[location.presetIndex].channels[
          location.channelIndex
        ].id !== location.channelId
      )
        throw new Error('The hardware gain editor context changed');
      return hardwareGainViewKey(location);
    });
    if (new Set(keys).size !== keys.length)
      throw new Error('Duplicate hardware gain editor context');
    // Validate the entire admitted intent before retaining any role's view.
    locations.forEach((location, index) =>
      retainedHardwareGainViews.current.set(keys[index], { ...location }),
    );
  };
  const hardwareGainAvailable =
    getHardwareGainContext({ slot: w.slot, presetIndex: w.preset, channelIndex: w.channel })
      ?.available === true;
  const editChannel = (
    patch: ChannelEditPatch,
    channelIndex = w.channel,
    options: ChannelEditOptions = {},
  ) => {
    try {
      const current = useWorkspace.getState();
      if (current.slot !== w.slot || current.preset !== w.preset || current.channel !== w.channel)
        throw new Error('The selected channel changed before this edit');
      const slots: Slot[] = current.linkedEdits ? ['left', 'right'] : [current.slot];
      const plan = planChannelEdit(
        current.documents,
        slots,
        { presetIndex: current.preset, channelIndex, patch },
        current.documentRevision,
        {
          ...options,
          hardwareGainContext: Object.fromEntries(
            slots.map((slot) => [
              slot,
              getHardwareGainContext({ slot, presetIndex: current.preset, channelIndex }),
            ]),
          ),
        },
      );
      if (plan.changedSlots.length)
        current.editAt(
          plan.changedSlots,
          (project, slot) => applyChannelEdit(project, slot, plan),
          { synchronizeLinks: plan.synchronizeLinks },
        );
      if (patch.hardwareGain !== undefined)
        retainHardwareGainContexts(
          plan.roles.map((role) => ({
            slot: role.slot,
            presetIndex: current.preset,
            channelIndex,
            channelId: role.context[channelIndex].id,
          })),
        );
      return plan.roles.find((role) => role.slot === current.slot);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const editFilter = (
    patch: ManualFilterPatch,
    redesign = false,
    forceEqRedesign = false,
    { sourceQEvent = false }: { sourceQEvent?: boolean } = {},
  ) => {
    try {
      const current = useWorkspace.getState();
      if (
        current.slot !== w.slot ||
        current.preset !== w.preset ||
        current.channel !== w.channel ||
        current.filter !== w.filter
      )
        throw new Error('The selected filter changed before this edit');
      const slots: Slot[] = current.linkedEdits ? ['left', 'right'] : [current.slot];
      const prepare = (p: Project) => {
        const pr = p.presets[w.preset],
          c = pr.channels[w.channel];
        if (tab !== 'Input EQ' && c.linkedTo !== undefined)
          throw new Error(
            'A target channel is linked. Edit its master channel or unlink it first.',
          );
        const list = tab === 'Input EQ' ? pr.inputEq : c.filters,
          index = tab === 'Input EQ' ? eqIndex : w.filter,
          original = list[index],
          next =
            tab === 'Input EQ'
              ? editInputEqBand(original, patch, {
                  normalize: false,
                  redesign: forceEqRedesign,
                })
              : editManualFilter(original, patch, {
                  redesign,
                  manualFrequency: false,
                  manualParameters: false,
                });
        if (tab === 'Input EQ') encodeEq(list.map((f, i) => (i === index ? next : f)));
        return { list, index, original, next, channel: c };
      };
      // Validate every independent target before the single workspace edit.
      // Reapply the pure patch to each detached target, never a source vector.
      const proposals = slots.map((slot) => ({ slot, ...prepare(current.documents[slot]) }));
      const source = proposals.find((proposal) => proposal.slot === current.slot)!;
      const changedSlots = sourceQEvent
        ? Object.is(source.original.q, source.next.q)
          ? []
          : proposals
              .filter((proposal) => !Object.is(proposal.original.q, proposal.next.q))
              .map((proposal) => proposal.slot)
        : slots;
      if (changedSlots.length)
        current.editAt(changedSlots, (p) => {
          const prepared = prepare(p);
          prepared.list[prepared.index] = prepared.next;
          if (redesign && prepared.next.kind !== 'raw' && tab !== 'Input EQ' && w.filter === 0)
            prepared.channel.coefficientCache = 'base';
        });
      setError('');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const startGraphDrag = (index: number) => {
    try {
      const initial = useWorkspace.getState();
      if (
        tabRef.current !== 'Crossover' ||
        modeRef.current !== 'Magnitude' ||
        initial.slot !== w.slot ||
        initial.preset !== w.preset ||
        initial.channel !== w.channel ||
        initial.filter !== index
      )
        throw new Error('The ordinary graph drag target changed');
      const slots: Slot[] = initial.linkedEdits ? ['left', 'right'] : [initial.slot];
      const location = {
        presetIndex: initial.preset,
        channelIndex: initial.channel,
        filterIndex: index,
      };
      let capture = captureManualFilterDrag(
        initial.documents,
        slots,
        location,
        initial.documentRevision,
      );
      const token = initial.beginOwnedGesture(),
        sourceSlot = initial.slot,
        linked = initial.linkedEdits;
      return {
        change: (pointer: import('../domain/manual-graph-drag').ManualGraphDragPointer) => {
          try {
            const current = useWorkspace.getState();
            if (
              !current.isOwnedGestureCurrent(token) ||
              current.slot !== sourceSlot ||
              current.preset !== location.presetIndex ||
              current.channel !== location.channelIndex ||
              current.filter !== location.filterIndex ||
              current.linkedEdits !== linked ||
              tabRef.current !== 'Crossover' ||
              modeRef.current !== 'Magnitude'
            )
              throw new Error('The ordinary graph drag is stale');
            const plan = planManualFilterDrag(
              current.documents,
              capture,
              pointer,
              current.documentRevision,
            );
            if (plan.changedSlots.length)
              current.editAt(
                plan.changedSlots,
                (project, slot) => applyManualFilterDrag(project, slot, plan),
                { gestureToken: token },
              );
            capture = plan.nextCapture;
            setError('');
            return true;
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            return false;
          }
        },
        end: (cancel = false) => useWorkspace.getState().endOwnedGesture(token, cancel),
      };
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false as const;
    }
  };
  const graphQFilter = (q: number) => {
    try {
      if (!Number.isFinite(q) || modeRef.current !== 'Magnitude' || tabRef.current !== tab)
        throw new Error('Graph Q editing is available in Magnitude only; use the Q control');
      const current = useWorkspace.getState(),
        slots: Slot[] = current.linkedEdits ? ['left', 'right'] : [current.slot];
      if (tab !== 'Input EQ')
        for (const slot of slots) {
          const target =
            current.documents[slot].presets[w.preset].channels[w.channel].filters[w.filter];
          if (!supportsHfdGraphQ(target.kind))
            throw new Error(`Graph Q is unavailable for ${slot} ${target.kind}; use its Q control`);
        }
      return editFilter({ q }, true, false, { sourceQEvent: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const wheelFilter = (
    parameter: ManualFilterParameter,
    result: HfdManualWheelResult,
    direction: -1 | 1,
  ) => {
    try {
      const current = useWorkspace.getState();
      if (
        tab === 'Input EQ' ||
        current.slot !== w.slot ||
        current.preset !== w.preset ||
        current.channel !== w.channel ||
        current.filter !== w.filter
      )
        throw new Error('The parameter wheel target changed');
      const slots: Slot[] = current.linkedEdits ? ['left', 'right'] : [current.slot];
      const plan = planManualFilterWheel(
        current.documents,
        slots,
        {
          presetIndex: current.preset,
          channelIndex: current.channel,
          filterIndex: current.filter,
          parameter,
          direction,
          basis: current.slot,
        },
        {
          slot: current.slot,
          filterId: filter.id,
          before: filter[parameter],
          additionalGain: channel.additionalGain ?? 0,
          result,
        },
      );
      if (plan.changedSlots.length)
        current.editAt(plan.changedSlots, (project) => applyManualFilterWheel(project, plan));
      setError('');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  function openPalette(mode: 'add' | 'replace', requestedIndex?: number, frequency?: number) {
    const captured = useWorkspace.getState(),
      eq = tabRef.current === 'Input EQ',
      selectedPreset = captured.documents[captured.slot].presets[captured.preset],
      selectedChannel = selectedPreset.channels[captured.channel],
      slots: Slot[] = captured.linkedEdits ? ['left', 'right'] : [captured.slot],
      list = eq ? selectedPreset.inputEq : selectedChannel.filters,
      index =
        mode === 'add'
          ? list.findIndex((f) => isUnusedBiquad(f) && (!eq || !f.enabled))
          : (requestedIndex ?? (eq ? eqIndex : captured.filter));
    if (index < 0 || index >= list.length) {
      setError('All sections are in use. Change an existing filter shape or remove a section.');
      return false;
    }
    for (const slot of slots) {
      const targetPreset = captured.documents[slot].presets[captured.preset],
        targetChannel = targetPreset?.channels[captured.channel],
        targetList = eq ? targetPreset?.inputEq : targetChannel?.filters,
        target = targetList?.[index];
      if (
        !target ||
        (!eq && targetChannel.linkedTo !== undefined) ||
        (mode === 'add' && (!isUnusedBiquad(target) || (eq && target.enabled)))
      ) {
        setError(`The ${slot} section is unavailable or its channel is linked to a master.`);
        return false;
      }
    }
    // Admit every palette target and construct its draft before entering the
    // source Graph. Opening this ordinary editor explicitly reveals that Graph;
    // it is separate from passive role/channel selection in a hidden editor.
    let draft =
      mode === 'add'
        ? { ...newFilter('peak'), frequency: frequency ?? 1000, gain: 3 }
        : structuredClone(list[index]);
    if (!eq) {
      try {
        chooseWorkspace(
          {
            slot: captured.slot,
            preset: captured.preset,
            channel: captured.channel,
            filter: index,
          },
          { openGraph: true, explicitChannelSelection: false },
        );
        setWorkspaceTabOnly('Crossover');
        setWorkspaceDesignerOnly('graph');
        if (mode === 'replace')
          draft = structuredClone(
            useWorkspace.getState().documents[captured.slot].presets[captured.preset].channels[
              captured.channel
            ].filters[index],
          );
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    paletteEnabledExplicit.current = false;
    setPaletteDraft(draft);
    setPaletteFailure('');
    setPalette({
      mode,
      index,
      slot: captured.slot,
      slots,
      preset: captured.preset,
      channel: captured.channel,
      eq,
    });
    return true;
  }
  function updatePalette(patch: ManualFilterPatch, manualParameters = true) {
    if (palette?.eq && patch.coefficients !== undefined)
      throw new Error('Input EQ does not support custom coefficients');
    setPaletteFailure('');
    if (Object.hasOwn(patch, 'enabled')) paletteEnabledExplicit.current = true;
    setPaletteDraft((old) => {
      const next = palette?.eq
        ? editInputEqBand(old, patch, { normalize: manualParameters })
        : editManualFilter(old, patch, {
            manualParameters,
          });
      if (!palette?.eq && next.kind !== 'raw') {
        delete next.coefficients;
        delete next.provenance;
      }
      return next;
    });
  }
  function applyPalette(strict = false) {
    if (!palette) {
      if (strict === true) throw new Error('No filter palette is open');
      return;
    }
    try {
      w.editAt(palette.slots, (p) => {
        const pr = p.presets[palette.preset],
          c = pr.channels[palette.channel],
          list = palette.eq ? pr.inputEq : c.filters;
        if (!palette.eq && c.linkedTo !== undefined)
          throw new Error('A target channel is linked to a master.');
        const old = list[palette.index];
        if (palette.mode === 'add' && (!isUnusedBiquad(old) || (palette.eq && old.enabled)))
          throw new Error(
            'The target section changed while previewing. Choose a free section again.',
          );
        list[palette.index] = {
          ...structuredClone(paletteDraft),
          enabled:
            palette.mode === 'replace' && !paletteEnabledExplicit.current
              ? old.enabled
              : paletteDraft.enabled,
          id: old.id,
          sourceId: old.sourceId,
        };
        if (
          !palette.eq &&
          palette.index === 0 &&
          !paletteDraft.provenance &&
          (paletteDraft.kind !== 'raw' || palette.mode === 'add')
        )
          c.coefficientCache = 'base';
        if (palette.eq) encodeEq(list);
        else encodeChannel(c);
      });
      setWorkspaceTabOnly(palette.eq ? 'Input EQ' : 'Crossover');
      chooseWorkspace(
        {
          slot: palette.slot,
          preset: palette.preset,
          channel: palette.channel,
          ...(!palette.eq ? { filter: palette.index } : {}),
        },
        { explicitChannelSelection: false, initializeGraph: false },
      );
      if (palette.eq) setEqIndex(palette.index);
      setNotice(
        `${FILTER_LABELS[paletteDraft.kind]} applied to ${palette.slots.join(' + ')} design. Upload when ready.`,
      );
      setPalette(undefined);
    } catch (e) {
      setPaletteFailure(e instanceof Error ? e.message : String(e));
      if (strict === true) throw e;
    }
  }
  const filter = tab === 'Input EQ' ? preset.inputEq[eqIndex] : channel.filters[w.filter];
  const sectionPreview = useMemo(() => {
    try {
      return {
        channel: selectedSectionAnalysisChannel(
          tab === 'Input EQ' ? plotChannels[0] : channel,
          filter,
          tab === 'Input EQ' ? eqIndex : w.filter,
        ),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Selected section response unavailable',
      };
    }
  }, [channel, filter, tab, plotChannels, eqIndex, w.filter]);
  const move = (direction: number) =>
    w.edit((p) => {
      const filters = p.presets[w.preset].channels[w.channel].filters,
        i = w.filter,
        j = i + direction;
      if (j >= 0 && j < 15) [filters[i], filters[j]] = [filters[j], filters[i]];
    });
  let coefficients: ReturnType<typeof design> | undefined;
  let designError = '';
  try {
    coefficients = filter.kind === 'raw' ? selectedSectionCoefficients(filter) : design(filter);
    effectiveSections(channel);
  } catch (e) {
    designError = String(e);
  }
  const selectedLive = live[w.slot];
  useEffect(() => {
    setAuthView('closed');
  }, [w.slot, selectedLive?.connectionId]);
  const disconnectAmplifier = async (slot: Slot) => {
    delete firmwareAssignments.current[slot];
    firmwareExecution.refreshContext();
    const connection = liveRef.current[slot];
    if (!connection) return;
    let noiseFailure: unknown;
    try {
      await noiseController.stopOwned(slot);
    } catch (error) {
      noiseFailure = error;
    }
    try {
      await connection.session.close();
    } finally {
      if (liveRef.current[slot]?.session === connection.session) {
        descriptorVerifier.clear(slot);
        deviceAuth.clear(slot);
        const next = { ...liveRef.current };
        delete next[slot];
        liveRef.current = next;
        setLive(next);
        noiseController.refreshBindings();
      }
    }
    if (noiseFailure)
      throw new Error(
        `USB was released, but the noise stop was not confirmed: ${noiseFailure instanceof Error ? noiseFailure.message : 'Stop request failed'}`,
      );
  };
  const adapter: ToolAdapter = {
    state: () => useWorkspace.getState(),
    edit: (slots, fn, options) =>
      useWorkspace.getState().editAt(slots, fn, { ...options, independent: true }),
    editByRole: (slots, fn, options) =>
      useWorkspace.getState().editAt(slots, fn, { ...options, independent: true }),
    hardwareGainContext: getHardwareGainContext,
    retainHardwareGainContexts,
    choose: chooseWorkspace,
    undo: () => useWorkspace.getState().undo(),
    redo: () => useWorkspace.getState().redo(),
    documentsReplaced: projectViewsReplaced,
    measurementsReplaced: refreshPhaseMeasurements,
    connections: () => liveRef.current,
    connect: requestConnection,
    disconnect: disconnectAmplifier,
    refresh: async (slots) => {
      for (const slot of slots) {
        const l = liveRef.current[slot];
        if (l) {
          const identity = await l.session.identify(),
            status = await l.session.status();
          const next = { ...liveRef.current, [slot]: { ...l, identity, status } };
          liveRef.current = next;
          setLive(next);
        }
      }
    },
    operate,
    capture: audioAccess?.controller,
    firmware: firmwareWorkspace,
    firmwareRuntime,
    firmwareExecution,
    noise: noiseController,
    descriptorVerifier,
    sources: projectSources,
    directoryWriter,
    reviewDirectoryLegacy: showLegacyRecordReview,
    sourceOpen: {
      status: sourceOpenStatus,
      retry: projectSourceOpener.retry,
      discard: projectSourceOpener.discard,
    },
    auth: deviceAuth,
    deviceDefaults,
    deviceClone,
    amplifierModes,
    nativeProjectSave,
    nativeLimiter,
    nativeMixer,
    eqClipboard: {
      get: () => (eqClipboard.current ? structuredClone(eqClipboard.current) : undefined),
      set: (bank, label) => {
        eqClipboard.current = structuredClone(bank);
        setEqClipboardLabel(label);
      },
      clear: () => {
        eqClipboard.current = undefined;
        setEqClipboardLabel('');
      },
      label: () => eqClipboardLabel,
    },
    persistence: {
      status: getWorkspacePersistenceStatus,
      retry: retryWorkspacePersistence,
      flush: flushWorkspacePersistence,
      recovery: getWorkspaceRecoveryText,
    },
    microphone: {
      remember: (reference) => useWorkspace.getState().rememberHfdCalibration(reference),
    },
    files: {
      manager: fileTransfers,
      revision: () => useWorkspace.getState().documentRevision ?? 0,
      commit: commitWorkspaceFile,
      lookup: (id, owner) => useWorkspace.getState().lookupFileCommit(id, owner),
    },
    viewState: () => ({
      noisePanel: showNoise,
      projectSavePanel: !!saveDialog,
      projectDirectory: directorySnapshotPage(directoryWriter.getSnapshot()),
      deviceDefaults: deviceDefaultsSnapshotPage(defaultsSnapshot),
      deviceClone: deviceCloneSnapshotPage(cloneSnapshot),
      amplifierModes: modesSnapshot,
      projectSaveCaptures: nativeSaveSnapshot,
      nativeLimiter: nativeLimiterSnapshotPage(nativeLimiterSnapshot),
      nativeMixer: nativeMixerSnapshot,
      firmwareRuntime: firmwareRuntimeSnapshot,
      workspaceAuthority: workspaceAuthority.getSnapshot(),
      noise: noiseController.getSnapshot(),
      sourceOpen: sourceOpenStatus(),
      tab,
      authPanel: authView,
      meters: showMeters,
      healthDetails,
      mode: modeRef.current,
      sum,
      measured,
      graph: (() => {
        const state = useWorkspace.getState();
        return {
          ...graphController.getSnapshot()[state.slot],
          availableRawMeasurements: state.documents[state.slot].presets[state.preset].channels.map(
            (c) => !!(c.measurement?.impulse?.length || c.measurement?.frequency?.length),
          ),
          channel: state.channel + 1,
        };
      })(),
      graphs: graphController.getSnapshot(),
      measurementView,
      calibrationCurve:
        channel.hfdMeasurement && project.hfdCalibration
          ? project.hfdCalibration.showCurve
          : calibrationCurve,
      nativeCentered,
      showUnloadedFilters,
      uploadResults: uploadReport,
      persistence: persistenceStatus,
      expertBank,
      designer,
      selectedBiquads: selectedBiquads.map((i) => i + 1),
      copySourceChannel: copySourceChannel === null ? null : copySourceChannel + 1,
      palette: palette
        ? {
            ...palette,
            preset: palette.preset + 1,
            channel: palette.channel + 1,
            index: palette.index + 1,
            draft: paletteDraft,
          }
        : null,
      eqBand: eqIndex + 1,
      eqClipboard: { present: !!eqClipboard.current, label: eqClipboardLabel },
      coefficients: showRaw,
      plotViews: plotController.getSnapshot(),
      plotViewport: plotController.getSnapshot()[useWorkspace.getState().slot][modeRef.current],
      nativeImpulseZoom: (() => {
        const selected = useWorkspace.getState();
        return (
          selected.documents[selected.slot].presets[selected.preset].channels[selected.channel]
            .hfdImpulseZoom ?? null
        );
      })(),
      ...plotController.getSnapshot()[useWorkspace.getState().slot][modeRef.current].range,
    }),
    message: setNotice,
    progress: (slot, percent, message) =>
      setProgress((old) => ({ ...old, [slot]: { percent, message } })),
    palette: async (action) => {
      if (action.action === 'open') {
        if (
          !openPalette(
            action.mode ?? 'add',
            action.index === undefined ? undefined : action.index - 1,
          )
        )
          throw new Error('No available section, invalid index or a read-only linked channel');
      } else if (action.action === 'update') {
        if (!palette) throw new Error('No filter palette is open');
        updatePalette(action.draft ?? {});
      } else if (action.action === 'apply') applyPalette(true);
      else setPalette(undefined);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    view: (patch) => {
      if (patch.projectSavePanel === false && directoryWriter.getSnapshot().busy)
        throw new Error('Finish the current folder operation before closing its review');
      if (
        (patch.graph?.sum !== undefined &&
          patch.sum !== undefined &&
          patch.graph.sum !== patch.sum) ||
        (patch.graph?.measured !== undefined &&
          patch.measured !== undefined &&
          patch.graph.measured !== patch.measured)
      )
        throw new Error('Conflicting graph view values');
      const requestedTab = (patch.tab as typeof tab | undefined) ?? tabRef.current,
        requestedDesigner = patch.designer ?? designerRef.current,
        graphTargetVisible = graphVisible(requestedTab, requestedDesigner);
      const graphPatch: GraphViewPatch = {
          ...patch.graph,
          ...(patch.sum === undefined ? {} : { sum: patch.sum }),
          ...(patch.measured === undefined ? {} : { measured: patch.measured }),
        },
        enteringGraph =
          graphTargetVisible &&
          (patch.tab === 'Crossover' ||
            patch.designer === 'graph' ||
            Object.keys(graphPatch).length > 0),
        capturedGraphWorkspace = useWorkspace.getState(),
        graphPlan = Object.keys(graphPatch).length
          ? graphController.plan(graphContext(capturedGraphWorkspace), graphPatch)
          : enteringGraph
            ? graphController.selection(graphContext(capturedGraphWorkspace), { normalize: true })
            : undefined;
      const requestedMode = (patch.mode as PlotMode | undefined) ?? modeRef.current,
        plotContext = { slot: capturedGraphWorkspace.slot, mode: requestedMode },
        previousViewport = plotController.getSnapshot()[plotContext.slot][plotContext.mode],
        rangeKeys = [
          'frequencyMin',
          'frequencyMax',
          'dbMin',
          'dbMax',
          'timeMinMs',
          'timeMaxMs',
          'amplitudeMin',
          'amplitudeMax',
        ] as const,
        rangePatch = Object.fromEntries(
          rangeKeys.filter((key) => patch[key] !== undefined).map((key) => [key, patch[key]]),
        ),
        automaticFit =
          patch.mode !== undefined &&
          !patch.zoomBack &&
          (requestedMode === 'Impulse' || requestedMode === 'Step') &&
          !previousViewport.touched &&
          !patch.resetPlot &&
          !rangeKeys.some((key) => key in patch),
        wantsFit = patch.fitTime !== undefined || automaticFit,
        changesRange = patch.resetPlot || Object.keys(rangePatch).length > 0 || wantsFit;
      const timedPlot = requestedMode === 'Impulse' || requestedMode === 'Step';
      if (patch.zoomRectangle) {
        const required = timedPlot
          ? (['timeMinMs', 'timeMaxMs', 'amplitudeMin', 'amplitudeMax'] as const)
          : (['frequencyMin', 'frequencyMax', 'dbMin', 'dbMax'] as const);
        if (
          required.some((key) => patch[key] === undefined) ||
          patch.resetPlot ||
          patch.fitTime ||
          patch.zoomBack
        )
          throw new Error(
            'Rectangle zoom needs all four bounds and cannot combine Fit, Reset or Zoom back',
          );
      }
      const saveNativeBounds =
        requestedMode === 'Impulse' &&
        requestedTab === 'Crossover' &&
        !patch.resetPlot &&
        (!!patch.zoomBack ||
          !!patch.zoomRectangle ||
          patch.fitTime !== undefined ||
          ['timeMinMs', 'timeMaxMs', 'amplitudeMin', 'amplitudeMax'].some(
            (key) => patch[key as keyof typeof patch] !== undefined,
          ));
      if (saveNativeBounds && capturedGraphWorkspace.gesture)
        throw new Error('Finish the current graph edit before saving the Impulse view');
      if (patch.zoomBack && (changesRange || patch.fitTime))
        throw new Error('Zoom back cannot be combined with a new plot range');
      let nextRange = {
        ...(patch.resetPlot ? defaultPlotRange(requestedMode) : previousViewport.range),
        ...rangePatch,
      };
      if (wantsFit)
        nextRange = {
          ...nextRange,
          ...timeFit(
            patch.fitTime ?? 'response',
            requestedMode,
            graphPlan?.next.measured ?? measured,
            (patch.tab as typeof tab | undefined) ?? tab,
            graphPlan?.next.sum ?? sum,
          ),
        };
      validatePlotRange(nextRange);
      if (saveNativeBounds) nativeImpulseZoomFromRange(nextRange);
      if (saveNativeBounds) capturedGraphWorkspace.beginGesture();
      try {
        if (graphPlan)
          commitGraphPlan(
            graphPlan,
            capturedGraphWorkspace,
            capturedGraphWorkspace,
            undefined,
            enteringGraph ? {} : undefined,
            graphTargetVisible,
          );
        if (patch.authPanel !== undefined) setAuthView(patch.authPanel);
        if (patch.meters !== undefined) setShowMeters(patch.meters);
        if (patch.healthDetails !== undefined) setHealthDetails(patch.healthDetails);
        if (patch.noisePanel !== undefined) setShowNoise(patch.noisePanel);
        if (patch.projectSavePanel === true) openProjectSave();
        if (patch.projectSavePanel === false) closeProjectSave();
        if (patch.measurementView !== undefined) setMeasurementView(patch.measurementView);
        if (patch.nativeCentered !== undefined) setNativeCentered(patch.nativeCentered);
        if (patch.showUnloadedFilters !== undefined)
          setShowUnloadedFilters(patch.showUnloadedFilters);
        if (patch.designer !== undefined) setWorkspaceDesignerOnly(patch.designer);
        if (patch.selectedBiquads !== undefined)
          setSelectedBiquads(patch.selectedBiquads.map((i) => i - 1));
        if (patch.copySourceChannel !== undefined)
          setCopySourceChannel(
            patch.copySourceChannel === null ? null : patch.copySourceChannel - 1,
          );
        if (patch.expertBank !== undefined) setExpertBank(patch.expertBank);
        if (patch.eqBand !== undefined) setEqIndex(patch.eqBand - 1);
        if (patch.coefficients !== undefined) setShowRaw(patch.coefficients);
        if (patch.zoomRectangle)
          plotController.rectangle(
            plotContext,
            {
              kind: 'zoom',
              axes: timedPlot
                ? {
                    xMin: nextRange.timeMinMs,
                    xMax: nextRange.timeMaxMs,
                    yMin: nextRange.amplitudeMin,
                    yMax: nextRange.amplitudeMax,
                    xScale: 'linear',
                  }
                : {
                    xMin: nextRange.frequencyMin,
                    xMax: nextRange.frequencyMax,
                    yMin: nextRange.dbMin,
                    yMax: nextRange.dbMax,
                    xScale: 'logarithmic',
                  },
            },
            previousViewport.range,
          );
        else if (changesRange)
          plotController.update(plotContext, nextRange, {
            expectedRange: previousViewport.range,
            clearHistory: !!patch.resetPlot || wantsFit,
          });
        if (patch.zoomBack)
          plotController.rectangle(plotContext, { kind: 'undo' }, previousViewport.range);
        if (patch.tab) setWorkspaceTabOnly(patch.tab as (typeof TABS)[number]);
        if (patch.mode) {
          modeRef.current = requestedMode;
          setMode(requestedMode);
        }
        if (patch.calibrationCurve !== undefined) {
          const state = useWorkspace.getState(),
            document = state.documents[state.slot];
          if (
            document.presets[state.preset].channels[state.channel].hfdMeasurement &&
            document.hfdCalibration
          )
            state.editAt(state.linkedEdits ? ['left', 'right'] : [state.slot], (p) =>
              setProjectMicrophoneOptions(p, { showCurve: patch.calibrationCurve }),
            );
          else setCalibrationCurve(patch.calibrationCurve);
        }
        if (
          requestedMode === 'Impulse' &&
          requestedTab === 'Input EQ' &&
          (changesRange || patch.zoomBack)
        )
          nativeImpulseView.invalidate([plotContext.slot]);
        if (saveNativeBounds) nativeImpulseView.commit(nativeImpulseView.capture());
        else if (requestedMode === 'Impulse' && requestedTab === 'Crossover' && !patch.resetPlot)
          restoreNativeImpulse();
      } catch (error) {
        if (saveNativeBounds) useWorkspace.getState().endGesture(true);
        throw error;
      } finally {
        if (saveNativeBounds && useWorkspace.getState().gesture)
          useWorkspace.getState().endGesture();
      }
    },
  };
  const eqCommand = (name: ToolName, args: unknown) => {
    void createToolExecutor(adapter)(name, args).then((value) => {
      const result = value as { ok: boolean; error?: string };
      if (!result.ok) setError(result.error ?? 'EQ operation failed');
    });
  };
  if (!hydrated || !persistenceStatus.hydrated)
    return (
      <div className="loading workspace-loading">
        {hydrated && persistenceStatus.error ? (
          <>
            <h1>Saved workspace could not be loaded</h1>
            <p>{persistenceStatus.error}</p>
            <div className="button-row">
              <button onClick={() => void retryWorkspacePersistence().catch(() => {})}>
                Retry loading
              </button>
              <button
                disabled={!getWorkspaceRecoveryText()}
                onClick={() => {
                  const text = getWorkspaceRecoveryText();
                  if (text) download('fusion-workspace-recovery.json', text);
                }}
              >
                Export recovery data
              </button>
            </div>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={20} />
            <p>Loading saved workspace…</p>
          </>
        )}
      </div>
    );
  return (
    <div className="studio">
      {palette && (
        <FilterPalette
          mode={palette.mode}
          draft={paletteDraft}
          onDraft={(patch) => updatePalette(patch, false)}
          preset={w.documents[palette.slot].presets[palette.preset]}
          channelIndex={palette.channel}
          sectionIndex={palette.index}
          contextKey={palette.slots
            .map(
              (slot) =>
                `${slot}:${documentEpochs[slot]}:${w.documents[slot].presets[palette.preset].channels[palette.channel].coefficientCache ?? 'base'}`,
            )
            .join('|')}
          targets={palette.slots.map(
            (slot) =>
              `${slot === 'left' ? 'Left' : 'Right'} · Preset ${palette.preset + 1} · ${palette.eq ? 'Input EQ · all outputs' : w.documents[slot].presets[palette.preset].channels[palette.channel].name}`,
          )}
          onApply={() => applyPalette()}
          onClose={() => setPalette(undefined)}
          eq={palette.eq}
          failure={paletteFailure}
          frequencyMaximum={plotViews[palette.slot].Magnitude.range.frequencyMax}
        />
      )}

      <input
        ref={file}
        type="file"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const apply = pendingFile.current;
            apply?.(await readFileText(f), f.name);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <header className="header" aria-label="Project and amplifier controls">
        <div className="project-title">
          <input
            aria-label="Project name"
            maxLength={200}
            title={project.name}
            value={project.name}
            onChange={(e) =>
              w.edit((p) => {
                p.name = e.target.value;
              }, false)
            }
          />
          <span
            className={`local-dot ${persistenceStatus.error ? 'save-error' : persistenceStatus.unsaved ? 'saving' : ''}`}
            aria-label={
              persistenceStatus.error
                ? 'Workspace not saved'
                : persistenceStatus.saving
                  ? 'Saving workspace'
                  : 'Workspace saved'
            }
            title={
              persistenceStatus.error ??
              (persistenceStatus.saving ? 'Saving in this browser' : 'Saved in this browser')
            }
          />
        </div>
        <div className="header-actions">
          <button
            aria-label="Undo"
            title="Undo · Ctrl/⌘ Z"
            onClick={() => w.undo()}
            disabled={!w.past.length}
          >
            <Undo2 size={16} />
          </button>
          <button
            aria-label="Redo"
            title="Redo · Ctrl/⌘ Shift Z"
            onClick={() => w.redo()}
            disabled={!w.future.length}
          >
            <Redo2 size={16} />
          </button>
          <button
            aria-label="Open project"
            title="Open project"
            onClick={() =>
              readFile('.xml,.json', (text, name) => {
                w.replaceAt(w.slot, parseProject(text, name.replace(/\.[^.]+$/, '')));
                projectViewsReplaced([w.slot]);
                setNotice('Project imported into ' + w.slot + '. Device settings unchanged.');
              })
            }
          >
            <FolderOpen size={16} />
          </button>
          <button
            aria-label="Save project"
            title="Save project · Ctrl/⌘ S"
            onClick={openProjectSave}
            disabled={authorityStatus.phase !== 'ready'}
          >
            <Save size={16} />
          </button>
        </div>
        <div className="header-amplifiers" aria-label="Amplifiers">
          {SLOTS.map((slot) => {
            const l = live[slot],
              label = slot === 'left' ? 'Left' : 'Right';
            return (
              <div key={slot} className={`amp-card ${w.slot === slot ? 'selected' : ''}`}>
                <button
                  className="amp-info"
                  aria-pressed={w.slot === slot}
                  aria-label={`Edit ${label} amplifier`}
                  title={`${label} · ${l ? `${l.identity.firmware} · ${l.status.muted ? 'Muted' : `${l.status.volume.toFixed(1)} dB`} · Preset ${l.status.preset}` : 'USB not connected'}`}
                  onClick={() => chooseWorkspace({ slot })}
                >
                  <span className={`amp-dot ${l ? 'connected' : 'offline'}`} />
                  <strong>{label}</strong>
                  <small>
                    {l
                      ? l.status.muted
                        ? 'Muted'
                        : `${l.status.volume.toFixed(1)} dB`
                      : 'Offline'}
                  </small>
                </button>
                <button
                  aria-label={`${l ? 'Disconnect' : 'Connect'} ${label} amplifier`}
                  title={`${l ? 'Disconnect' : 'Connect'} ${label} USB`}
                  disabled={!!busy}
                  onClick={() =>
                    l ? run('Disconnecting', () => disconnectAmplifier(slot)) : connect(slot)
                  }
                >
                  {l ? <Unplug size={14} /> : <Cable size={14} />}
                </button>
              </div>
            );
          })}
        </div>
        <Toggle checked={w.linkedControls} onChange={(v) => chooseWorkspace({ linkedControls: v })}>
          <Link2 size={13} />
          Link controls
        </Toggle>
        <div className="header-upload">
          <button className="primary" disabled={!!busy || !selectedLive} onClick={() => upload()}>
            <ArrowUpFromLine size={15} />
            <span>Upload preset</span>
          </button>
          <button
            aria-label="Upload both amplifiers"
            title="Upload both amplifiers"
            disabled={!!busy || !live.left || !live.right}
            onClick={() => upload(true)}
          >
            <ArrowUpFromLine size={14} />
            <span>Both</span>
          </button>
          <details className="upload-options-menu">
            <summary aria-label="Upload options" title="Upload options">
              <ChevronDown size={14} />
            </summary>
            <div className="upload-options">
              <strong>All crossover presets · 1, 2 and 3</strong>
              <button
                disabled={!!busy || !selectedLive}
                onClick={(e) => {
                  e.currentTarget.closest('details')?.removeAttribute('open');
                  void uploadAll();
                }}
              >
                Upload all to {w.slot === 'left' ? 'Left' : 'Right'}
              </button>
              <button
                disabled={!!busy || !live.left || !live.right}
                onClick={(e) => {
                  e.currentTarget.closest('details')?.removeAttribute('open');
                  void uploadAll(true);
                }}
              >
                Upload all to both
              </button>
              <small>IIR + assigned FIR. Input EQ is uploaded separately.</small>
            </div>
          </details>
        </div>
      </header>
      <main className="workspace">
        <nav className="tool-rail" aria-label="Workspace tools">
          {TABS.map((t, i) => {
            const Icon = [
              SlidersHorizontal,
              Activity,
              Waves,
              AudioLines,
              Settings2,
              ShieldCheck,
              CircleHelp,
              Check,
              Link2,
            ][i];
            return (
              <button
                key={t}
                aria-label={t}
                title={t}
                aria-current={tab === t ? 'page' : undefined}
                className={tab === t ? 'active' : ''}
                onClick={() => designAction(() => openWorkspaceTab(t), `${t} opened.`)}
              >
                <Icon size={18} />
                <span>{['XO', 'EQ', 'FIR', 'IR', 'AMP', 'SAVE', 'HELP', 'CHECK', 'MCP'][i]}</span>
              </button>
            );
          })}
        </nav>
        <aside className="sidebar">
          <div className="section-label">
            EDITING <span>{w.slot.toUpperCase()}</span>
          </div>
          <div className="preset-tabs">
            {[0, 1, 2].map((i) => (
              <button
                key={i}
                className={w.preset === i ? 'active' : ''}
                onClick={() => chooseWorkspace({ preset: i, filter: 0 })}
              >
                Preset {i + 1}
              </button>
            ))}
          </div>
          <input
            className="preset-name"
            aria-label="Preset name"
            value={preset.name}
            onChange={(e) =>
              w.edit((p) => {
                p.presets[w.preset].name = e.target.value;
              })
            }
          />
          {uploadFirWarnings.length > 0 && (
            <details className="side-section" aria-label="Upload FIR scope">
              <summary style={{ fontSize: 9, lineHeight: 1.5, cursor: 'pointer' }}>
                FIR upload scope · {uploadFirWarnings.length}{' '}
                {uploadFirWarnings.length === 1 ? 'advisory' : 'advisories'}
                <small
                  style={{ display: 'block', fontSize: 8, marginLeft: 12, color: 'var(--muted)' }}
                >
                  Other-placement FIRs stay in the graph; not uploaded.
                </small>
                <small
                  style={{ display: 'block', fontSize: 8, marginLeft: 12, color: 'var(--muted)' }}
                >
                  {SLOTS.flatMap((slot) => {
                    const presets = [
                      ...new Set(
                        uploadFirWarnings
                          .filter((warning) => warning.slot === slot)
                          .map((warning) => warning.preset),
                      ),
                    ];
                    return presets.length
                      ? [`${slot === 'left' ? 'Left' : 'Right'} P${presets.join(',')}`]
                      : [];
                  }).join(' · ')}
                </small>
              </summary>
              <div
                role="region"
                aria-label="FIR upload advisories"
                tabIndex={0}
                style={{ maxHeight: 160, overflowY: 'auto' }}
              >
                {uploadFirWarnings.map((warning) => (
                  <p className="hint" key={`${warning.slot}:${warning.preset}:${warning.message}`}>
                    {warning.slot === 'left' ? 'Left' : 'Right'} · Preset {warning.preset}:{' '}
                    {warning.message}
                  </p>
                ))}
              </div>
            </details>
          )}
          <div className="channel-list">
            {preset.channels.map((c, i) => (
              <button
                key={c.id}
                style={{ '--channel-color': COLORS[i] } as React.CSSProperties}
                className={w.channel === i ? 'active' : ''}
                onClick={() => chooseWorkspace({ channel: i, filter: 0 })}
              >
                <span className="channel-number">0{i + 1}</span>
                <div>
                  <strong>{c.name}</strong>
                  <small>
                    {c.filters.filter((f) => f.enabled && f.kind !== 'unity').length} filters ·{' '}
                    {c.gain.toFixed(1)} dB
                  </small>
                </div>
                <span className="channel-pip" />
              </button>
            ))}
          </div>
          <div className="side-section">
            <div className="section-label">
              CHANNEL PARAMETERS <SlidersHorizontal size={13} />
            </div>
            <label className="field-label">
              Channel name
              <input value={channel.name} onChange={(e) => editChannel({ name: e.target.value })} />
            </label>
            <div
              ref={hardwareGainInput}
              data-channel-gain-context={`${w.slot}:${documentEpochs[w.slot]}:${w.preset}:${channel.id}`}
            >
              <Numeric
                contextKey={`${w.slot}:${w.preset}:${channel.id}:${documentEpochs[w.slot]}:gain:${channel.additionalGain ?? 0}`}
                channelGain
                channelGainAdditionalGain={channel.additionalGain ?? 0}
                channelGainRevision={w.documentRevision}
                getChannelGainRevision={() => useWorkspace.getState().documentRevision}
                begin={beginNumericGesture}
                end={w.endGesture}
                disabled={channel.linkedTo !== undefined}
                label="Gain"
                value={channel.gain}
                onChange={(gain) => editChannel({ gain })}
                onTextCommit={(text) => {
                  const role = editChannel({ gain: text });
                  return role ? role.gainResult! : false;
                }}
                onChannelGainWheel={(result, direction) => {
                  const role = editChannel({ gainWheel: { direction, basis: w.slot } }, w.channel, {
                    gainWheelSourceEvent: {
                      slot: w.slot,
                      channelId: channel.id,
                      expectedGain: channel.gain,
                      expectedAdditionalGain: channel.additionalGain ?? 0,
                      result,
                    },
                  });
                  return role !== false;
                }}
                unit="dB"
                min={HFD_CHANNEL_GAIN_BOUNDS.min}
                max={HFD_CHANNEL_GAIN_BOUNDS.max}
                adjustmentBounds={HFD_CHANNEL_GAIN_BOUNDS}
                step={0.1}
              />
            </div>
            {hardwareGainAvailable && (
              <>
                <label className="toggle-label">
                  <input
                    aria-label="Hardware gain compensation"
                    type="checkbox"
                    disabled={channel.linkedTo !== undefined}
                    checked={(channel.additionalGain ?? 0) !== 0}
                    onChange={(event) => editChannel({ hardwareGain: event.target.checked })}
                  />
                  <span className="switch" />
                  Hardware gain compensation
                </label>
                <p className="hint">Design compensation only · amplifier settings stay separate.</p>
              </>
            )}
            <Numeric
              begin={beginNumericGesture}
              end={w.endGesture}
              disabled={channel.linkedTo !== undefined}
              label="Delay"
              contextKey={`${w.slot}:${w.preset}:${channel.id}:${documentEpochs[w.slot]}:delay`}
              value={channel.delayUs}
              onChange={(delayUs) => editChannel({ delayUs })}
              unit="µs"
              min={0}
              max={32000}
              step={10.6666666667}
            />
            <Numeric
              begin={beginNumericGesture}
              end={w.endGesture}
              label="Global delay · analysis"
              contextKey={`${w.slot}:${w.preset}:${channel.id}:${documentEpochs[w.slot]}:global-delay`}
              value={channel.globalDelayUs}
              onChange={(globalDelayUs) => editChannel({ globalDelayUs })}
              unit="µs"
              min={0}
              max={74666}
              step={10.6666666667}
            />
            <div className="parameter-hint">
              {((channel.delayUs + channel.globalDelayUs) * 0.343).toFixed(1)} mm ·{' '}
              {Math.round((channel.delayUs + channel.globalDelayUs) * 0.09375)} samples
            </div>
            {channel.coefficientCache === 'unresolved' && (
              <label className="field-label">
                Imported coefficients
                <select
                  aria-label="Imported coefficient gain"
                  defaultValue=""
                  onChange={(e) =>
                    w.edit((p) =>
                      resolveGainCache(
                        p.presets[w.preset].channels[w.channel],
                        e.target.value as 'base' | 'effective',
                      ),
                    )
                  }
                >
                  <option value="" disabled>
                    Choose gain interpretation
                  </option>
                  <option value="base">Base filter coefficients</option>
                  <option value="effective">Already include channel gain</option>
                </select>
              </label>
            )}
            <label className="field-label">
              Channel link
              <select
                aria-label="Channel link"
                value={channel.linkedTo ?? ''}
                onChange={(e) =>
                  w.edit((p) =>
                    linkChannel(
                      p.presets[w.preset],
                      w.channel,
                      e.target.value === '' ? null : Number(e.target.value),
                    ),
                  )
                }
              >
                <option value="">Independent channel</option>
                {preset.channels.map(
                  (c, i) =>
                    i !== w.channel && (
                      <option key={i} value={i}>
                        Follow {c.name}
                      </option>
                    ),
                )}
              </select>
            </label>
            <div className="polarity-row">
              <button
                disabled={channel.linkedTo !== undefined}
                className={channel.invert ? 'active' : ''}
                onClick={() => editChannel({ invert: !channel.invert })}
              >
                Ø Invert
              </button>
              <button
                disabled={channel.linkedTo !== undefined}
                className={channel.muted ? 'danger active' : ''}
                onClick={() => editChannel({ muted: !channel.muted })}
              >
                <VolumeX size={14} />
                Preview mute
              </button>
            </div>
          </div>
          <div className="side-section">
            <Toggle checked={w.linkedEdits} onChange={(v) => chooseWorkspace({ linkedEdits: v })}>
              <Link2 size={14} />
              Mirror L/R edits
            </Toggle>
            <p className="hint">
              Applies edits to matching channels. Each amplifier retains its own project.
            </p>
            <button
              className="full-width"
              onClick={() =>
                w.edit((p) => {
                  p.presets[w.preset].channels[w.channel] = structuredClone(
                    w.documents[w.slot === 'left' ? 'right' : 'left'].presets[w.preset].channels[
                      w.channel
                    ],
                  );
                }, false)
              }
            >
              <Copy size={14} />
              Copy from {w.slot === 'left' ? 'Right' : 'Left'}
            </button>
          </div>
        </aside>
        <section
          className={`main-pane ${tab === 'Crossover' || tab === 'Input EQ' || tab === 'Measurements' ? 'design-pane' : ''}`}
        >
          {(tab === 'Crossover' || tab === 'Input EQ') && (
            <div
              className={`design-workspace ${tab === 'Crossover' && designer === 'chain' ? 'chain-view' : ''}`}
            >
              <div className="response-workspace">
                <div className="graph-heading">
                  <div>
                    <h1>
                      {tab === 'Input EQ' ? 'Input equalizer' : channel.name}
                      <span>
                        {w.slot === 'left' ? 'LEFT' : 'RIGHT'} / P{w.preset + 1}
                      </span>
                    </h1>
                  </div>
                  <div className="graph-options">
                    <button
                      className="primary"
                      disabled={tab !== 'Input EQ' && channel.linkedTo !== undefined}
                      onClick={() => openPalette(tab === 'Input EQ' ? 'replace' : 'add')}
                    >
                      <Plus size={15} />
                      {tab === 'Input EQ' ? 'Choose band shape' : 'Add filter'}
                    </button>

                    {tab === 'Crossover' && (
                      <>
                        <label>
                          <input
                            type="checkbox"
                            checked={mode === 'Phase' ? graphView.phase.sum : sum}
                            onChange={(e) =>
                              designAction(
                                () =>
                                  patchGraph(
                                    mode === 'Phase'
                                      ? { phase: { sum: e.target.checked } }
                                      : { sum: e.target.checked },
                                  ),
                                mode === 'Phase'
                                  ? 'Phase sum visibility updated.'
                                  : 'Graph sum updated.',
                              )
                            }
                          />
                          {mode === 'Phase' ? 'Show phase sum' : 'Show sum'}
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={measured}
                            onChange={(e) => {
                              const value = e.target.checked;
                              designAction(
                                () => patchGraph({ measured: value }),
                                'Measurement preview updated.',
                              );
                              if (mode === 'Impulse' || mode === 'Step')
                                designAction(
                                  () => fitTime('response', mode, value),
                                  'Time response fitted.',
                                );
                            }}
                          />
                          Measurement
                        </label>
                      </>
                    )}
                    <button
                      disabled={!selectedLive || !!busy}
                      onClick={() =>
                        tab === 'Input EQ'
                          ? eqCommand('fusion_eq_read', { slot: w.slot, preset: w.preset + 1 })
                          : readPanel()
                      }
                    >
                      <ArrowDownToLine size={14} />
                      Read from amp
                    </button>
                    {tab === 'Input EQ' && (
                      <>
                        <LiveEqToggle
                          key={`${w.slot}:${selectedLive?.identity.serial ?? 'offline'}`}
                          live={selectedLive}
                          role={w.slot === 'left' ? 'Left' : 'Right'}
                          busy={!!busy}
                          onChange={(preset, enabled) =>
                            controls({ presetEq: { preset, enabled } })
                          }
                        />
                        <button
                          disabled={!selectedLive || !!busy}
                          onClick={() =>
                            eqCommand('fusion_eq_upload', { target: w.slot, preset: w.preset + 1 })
                          }
                        >
                          <ArrowUpFromLine size={14} />
                          Upload EQ
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {tab === 'Input EQ' && (
                  <EqPresetActions
                    preset={w.preset + 1}
                    livePreset={selectedLive?.status.preset}
                    busy={!!busy}
                    connected={!!selectedLive}
                    pairConnected={!!live.left && !!live.right}
                    role={w.slot === 'left' ? 'Left' : 'Right'}
                    designScope={w.linkedEdits ? 'L + R' : w.slot === 'left' ? 'Left' : 'Right'}
                    clipboardLabel={eqClipboardLabel}
                    onDefault={() =>
                      eqCommand('fusion_eq_default', {
                        target: w.linkedEdits ? 'both' : w.slot,
                        preset: w.preset + 1,
                      })
                    }
                    onCopyAll={() =>
                      eqCommand('fusion_eq_copy_all', {
                        target: w.linkedEdits ? 'both' : w.slot,
                        preset: w.preset + 1,
                      })
                    }
                    onSaveAll={(both) =>
                      eqCommand('fusion_eq_save_all', {
                        target: both ? 'both' : w.slot,
                        preset: w.preset + 1,
                      })
                    }
                    onSaveBoth={() =>
                      eqCommand('fusion_eq_upload', { target: 'both', preset: w.preset + 1 })
                    }
                    onBank={(action, both) =>
                      eqCommand('fusion_eq_bank', {
                        action,
                        source: w.slot,
                        target: both
                          ? 'both'
                          : action === 'apply-design' && w.linkedEdits
                            ? 'both'
                            : w.slot,
                      })
                    }
                  />
                )}
                <div className="graph-card">
                  <div className="plot-tabs">
                    {tab === 'Crossover' && (
                      <button
                        className={
                          designer === 'chain' ? 'active designer-switch' : 'designer-switch'
                        }
                        aria-pressed={designer === 'chain'}
                        onClick={() =>
                          designAction(
                            () => openWorkspaceDesigner(designer === 'chain' ? 'graph' : 'chain'),
                            'Crossover view updated.',
                          )
                        }
                      >
                        {designer === 'chain' ? 'Response graph' : 'Signal chain'}
                      </button>
                    )}
                    {(tab !== 'Crossover' || designer !== 'chain') && (
                      <>
                        {(
                          ['Magnitude', 'Phase', 'Group delay', 'Impulse', 'Step'] as PlotMode[]
                        ).map((m) => (
                          <button
                            key={m}
                            className={mode === m ? 'active' : ''}
                            onClick={() => choosePlotMode(m)}
                          >
                            {m}
                          </button>
                        ))}
                        {tab === 'Crossover' && mode === 'Magnitude' && (
                          <PlotLayerControls
                            state={graphView}
                            channels={preset.channels}
                            channelIndex={w.channel}
                            onPatch={(patch) =>
                              designAction(() => patchGraph(patch), 'Graph layers updated.')
                            }
                          />
                        )}
                        {tab === 'Crossover' && mode === 'Phase' && (
                          <PhaseLayers
                            state={graphView.phase}
                            channels={preset.channels}
                            showSumControl={false}
                            channelIndex={w.channel}
                            onPatch={(phase) =>
                              designAction(() => patchGraph({ phase }), 'Phase layers updated.')
                            }
                          />
                        )}
                        <div className="legend">
                          {tab === 'Input EQ' ? (
                            <span>
                              <i style={{ background: COLORS[0] }} />
                              Input EQ · all outputs
                            </span>
                          ) : (
                            preset.channels.map((c, i) => (
                              <label key={i}>
                                <input
                                  aria-label={`Include ${c.name} in sum`}
                                  type="checkbox"
                                  checked={c.includeInSum !== false}
                                  onChange={(e) =>
                                    editChannel({ includeInSum: e.target.checked }, i)
                                  }
                                />
                                <i style={{ background: COLORS[i] }} />
                                {c.outputName}
                              </label>
                            ))
                          )}
                          {(mode === 'Phase' ? graphView.phase.sum : sum) && tab !== 'Input EQ' && (
                            <span>
                              <i style={{ background: '#e9eddf' }} />
                              Sum
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {tab === 'Crossover' && designer === 'chain' ? (
                    <SignalChain
                      preset={preset}
                      channel={w.channel}
                      filter={w.filter}
                      selected={selectedBiquads}
                      copySource={copySourceChannel}
                      onSelect={selectChain}
                      onOpenGraph={(channel) => {
                        designAction(() => {
                          chooseWorkspace({ channel }, { openGraph: true });
                          setWorkspaceDesignerOnly('graph');
                        }, 'Channel graph opened.');
                      }}
                      onMarkCopy={setCopySourceChannel}
                      onCopyTo={(to) => {
                        if (copySourceChannel !== null)
                          designAction(
                            () =>
                              w.edit((p) =>
                                copyChannelProcessing(p, w.preset, copySourceChannel, to),
                              ),
                            'Channel processing copied; driver labels and measurement retained.',
                          );
                      }}
                      onExchange={() => {
                        if (selectedBiquads.length === 2)
                          designAction(
                            () =>
                              w.edit((p) =>
                                exchangeBiquads(
                                  p,
                                  w.preset,
                                  w.channel,
                                  selectedBiquads[0],
                                  selectedBiquads[1],
                                ),
                              ),
                            'Selected biquad parameters exchanged.',
                          );
                      }}
                      onMeasurement={(channel) =>
                        readFile('.dat,.txt,.frd', (text, name) => {
                          w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) => {
                            const c = p.presets[w.preset].channels[channel],
                              parsed = parseMeasurement(text, name),
                              rate =
                                c.hfdMeasurement?.sampleRate ?? c.measurement?.sampleRate ?? 48000;
                            const measurement =
                              parsed.impulse && parsed.sampleRate !== rate
                                ? { ...spectrum(parsed.impulse, rate), name }
                                : parsed;
                            importChannelMeasurement(c, measurement);
                          });
                          refreshPhaseMeasurements(
                            w.linkedEdits ? ['left', 'right'] : [w.slot],
                            w.preset,
                            [channel],
                          );
                        })
                      }
                      onOutputName={(channel, name) => editChannel({ outputName: name }, channel)}
                      onNavigate={openWorkspaceTab}
                    />
                  ) : (
                    <>
                      <InteractivePlot
                        channels={plotChannels}
                        preset={plotPreset}
                        mode={mode}
                        sum={sum && tab !== 'Input EQ'}
                        measured={measured && tab === 'Crossover'}
                        range={plotRange}
                        gainLimit={tab === 'Input EQ' ? 32 : 60}
                        nativeCentered={nativeCentered}
                        showUnloadedFilters={showUnloadedFilters}
                        magnitudeLayers={tab === 'Crossover' ? magnitudeLayers : undefined}
                        phaseLayers={tab === 'Crossover' ? graphView.phase : undefined}
                        selectedFilter={graphView.sectionScope === 'selected' ? w.filter : null}
                        onRange={setPlotRange}
                        onRangeGestureStart={() => {
                          nativeRangeGesture.current = undefined;
                          if (mode === 'Impulse' && tab === 'Crossover') {
                            try {
                              nativeRangeGesture.current = captureNativeRangeBinding();
                            } catch (error) {
                              setError(error instanceof Error ? error.message : String(error));
                            }
                          }
                        }}
                        onRangeGestureCommit={() => {
                          const binding = nativeRangeGesture.current;
                          nativeRangeGesture.current = undefined;
                          if (binding)
                            designAction(() => {
                              if (modeRef.current !== 'Impulse' || tabRef.current !== 'Crossover')
                                throw new Error('The Impulse view changed during this gesture');
                              nativeImpulseView.commit(binding);
                            }, 'Impulse view saved.');
                        }}
                        onRangeGestureCancel={() => {
                          nativeRangeGesture.current = undefined;
                        }}
                        contextKey={`${w.slot}:${w.preset}:${w.channel}:${channel.id}:${tab}:${mode}`}
                        onRectangleZoom={(zoom, captured) =>
                          designAction(() => {
                            const current = useWorkspace.getState();
                            if (
                              current.slot !== w.slot ||
                              current.preset !== w.preset ||
                              current.channel !== w.channel ||
                              modeRef.current !== mode
                            )
                              throw new Error('The plot target changed during this gesture');
                            plotController.rectangle({ slot: w.slot, mode }, zoom, captured);
                          }, 'Graph zoom updated.')
                        }
                        onResetRange={resetPlotRange}
                        activeChannel={tab === 'Input EQ' ? 0 : w.channel}
                        activeFilter={tab === 'Input EQ' ? eqIndex : w.filter}
                        onSelect={selectFilter}
                        onChange={(patch) => editFilter(patch, true)}
                        onGraphQChange={graphQFilter}
                        onGraphDragStart={tab === 'Input EQ' ? undefined : startGraphDrag}
                        qGestureProfile={tab === 'Input EQ' ? 'input-eq' : 'ordinary'}
                        onAdd={(frequency) => openPalette('add', undefined, frequency)}
                        onRemove={() =>
                          tab === 'Input EQ'
                            ? editFilter({ enabled: false, gain: 0 }, true, true)
                            : designAction(
                                () => w.edit((p) => deleteBiquad(p, w.preset, w.channel, w.filter)),
                                'Filter deleted; its settings are retained in the unused slot.',
                              )
                        }
                        onToggle={() => editFilter({ enabled: !filter.enabled })}
                        begin={w.beginGesture}
                        end={w.endGesture}
                      />
                      <div
                        className={`graph-footer ${mode === 'Impulse' || mode === 'Step' ? 'time-graph-controls' : ''}`}
                      >
                        {mode === 'Impulse' || mode === 'Step' ? (
                          <>
                            <span title="Drag to pan time/amplitude; wheel zooms time, Shift-wheel zooms amplitude; middle-drag selects a time range">
                              Drag to pan · Wheel to zoom
                            </span>
                            <button
                              disabled={
                                tab !== 'Crossover' ||
                                !measured ||
                                !channel.hfdMeasurement ||
                                !channel.measurement?.impulse?.length ||
                                !!busy
                              }
                              title={`Truncate original native samples to the visible ${plotRange.timeMinMs.toFixed(3)}..${plotRange.timeMaxMs.toFixed(3)} ms in ${w.linkedEdits ? 'both roles' : w.slot}, preset ${w.preset + 1}, output ${w.channel + 1}. Phase start and original samples are retained.`}
                              onClick={() =>
                                eqCommand('fusion_measurement_processing', {
                                  target: w.linkedEdits ? 'both' : w.slot,
                                  preset: w.preset + 1,
                                  channel: w.channel + 1,
                                  truncateToView: true,
                                })
                              }
                            >
                              Truncate
                            </button>
                            <button
                              onClick={() =>
                                designAction(() => fitTime('response'), 'Time response fitted.')
                              }
                            >
                              Fit response
                            </button>
                            <button
                              disabled={
                                tab !== 'Crossover' || !measured || !channel.measurement?.impulse
                              }
                              onClick={() =>
                                designAction(
                                  () => fitTime('truncated'),
                                  'Native truncated range fitted.',
                                )
                              }
                            >
                              Fit truncated
                            </button>
                            <Numeric
                              key={`${w.slot}:${w.preset}:${channel.id}:${tab}:${mode}:from`}
                              contextKey={w.documentRevision ?? 0}
                              label="Time from"
                              min={-600000}
                              max={599999.999}
                              value={plotRange.timeMinMs}
                              unit="ms"
                              commitOnly
                              onChange={(v) =>
                                designAction(
                                  () =>
                                    saveTimeRange((r) => ({
                                      ...r,
                                      timeMinMs: Math.min(v, r.timeMaxMs - 0.001),
                                    })),
                                  'Time range updated.',
                                )
                              }
                            />
                            <Numeric
                              key={`${w.slot}:${w.preset}:${channel.id}:${tab}:${mode}:to`}
                              contextKey={w.documentRevision ?? 0}
                              label="Time to"
                              min={-599999.999}
                              max={600000}
                              value={plotRange.timeMaxMs}
                              unit="ms"
                              commitOnly
                              onChange={(v) =>
                                designAction(
                                  () =>
                                    saveTimeRange((r) => ({
                                      ...r,
                                      timeMaxMs: Math.max(v, r.timeMinMs + 0.001),
                                    })),
                                  'Time range updated.',
                                )
                              }
                            />
                          </>
                        ) : (
                          <>
                            <span title="Drag background to pan; middle-drag to zoom">
                              {mode === 'Magnitude'
                                ? 'Drag: Hz / dB · Ctrl-drag or wheel: Q'
                                : 'Frequency / phase response'}
                            </span>
                            <button onClick={resetPlotRange}>Reset view</button>
                            {tab === 'Crossover' &&
                            measured &&
                            preset.channels.some((c) => c.hfdMeasurement) ? (
                              <>
                                <button
                                  aria-pressed={nativeCenterStatus.centered}
                                  disabled={!nativeCenterStatus.available}
                                  onClick={() => setNativeCentered(!nativeCentered)}
                                >
                                  {!nativeCenterStatus.available
                                    ? 'Centering unavailable'
                                    : nativeCentered
                                      ? 'HFD centered'
                                      : 'Absolute dB'}
                                </button>
                                <label className="native-filter-toggle">
                                  <input
                                    type="checkbox"
                                    checked={showUnloadedFilters}
                                    onChange={(e) => setShowUnloadedFilters(e.target.checked)}
                                  />
                                  Unloaded filters
                                </label>
                              </>
                            ) : (
                              <span>93.750 kHz · Q8.24</span>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <section className="filter-table">
                <div className="panel-heading">
                  <h2>
                    {tab === 'Input EQ' ? 'Your EQ bands' : 'Your filters'}{' '}
                    <small>
                      {
                        (tab === 'Input EQ' ? preset.inputEq : channel.filters).filter(
                          (f) => f.kind !== 'unity',
                        ).length
                      }
                      /{tab === 'Input EQ' ? 9 : 15}
                    </small>
                  </h2>
                  <button
                    className={expertBank ? 'active' : ''}
                    onClick={() => setExpertBank(!expertBank)}
                  >
                    {expertBank ? 'Filter list' : 'Biquad bank'}
                  </button>
                  <div>
                    {tab === 'Input EQ' ? (
                      <Toggle
                        checked={preset.eqEnabled}
                        onChange={(v) =>
                          w.edit((p) => {
                            p.presets[w.preset].eqEnabled = v;
                          })
                        }
                      >
                        Design EQ enabled
                      </Toggle>
                    ) : (
                      <>
                        <button
                          title="Move up"
                          disabled={w.filter === 0 || channel.linkedTo !== undefined}
                          onClick={() => {
                            move(-1);
                            chooseWorkspace({ filter: w.filter - 1 });
                          }}
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          title="Move down"
                          disabled={w.filter === 14 || channel.linkedTo !== undefined}
                          onClick={() => {
                            move(1);
                            chooseWorkspace({ filter: w.filter + 1 });
                          }}
                        >
                          <ChevronDown size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="filter-list-body" hidden={expertBank}>
                  <FilterCards
                    filters={tab === 'Input EQ' ? preset.inputEq : channel.filters}
                    selected={tab === 'Input EQ' ? eqIndex : w.filter}
                    eq={tab === 'Input EQ'}
                    readonly={tab !== 'Input EQ' && channel.linkedTo !== undefined}
                    onSelect={selectFilter}
                    onType={(i) => openPalette('replace', i)}
                    onAdd={() => openPalette('add')}
                    onToggle={(i) =>
                      w.edit((p) => {
                        const f = (
                          tab === 'Input EQ'
                            ? p.presets[w.preset].inputEq
                            : p.presets[w.preset].channels[w.channel].filters
                        )[i];
                        f.enabled = !f.enabled;
                      })
                    }
                    onRemove={(i) =>
                      designAction(
                        () =>
                          w.edit((p) => {
                            if (tab === 'Input EQ') p.presets[w.preset].inputEq[i].enabled = false;
                            else deleteBiquad(p, w.preset, w.channel, i);
                          }),
                        'Filter deleted; its settings are retained in the unused slot.',
                      )
                    }
                  />
                </div>
                <div className="table-scroll" hidden={!expertBank}>
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Filter</th>
                        <th>Frequency</th>
                        <th>Gain</th>
                        <th>Q</th>
                        <th>On</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(tab === 'Input EQ' ? preset.inputEq : channel.filters).map((f, i) => (
                        <tr
                          key={f.id}
                          className={
                            (tab === 'Input EQ' ? eqIndex : w.filter) === i ? 'selected' : ''
                          }
                          onClick={() => selectFilter(i)}
                        >
                          <td>{String(i + 1).padStart(2, '0')}</td>
                          <td>
                            <span className={`filter-dot ${f.enabled ? 'on' : ''}`} />
                            {FILTER_NAMES[f.kind]}{' '}
                            {f.provenance && (
                              <small className="source-tag">
                                {f.provenance === 'hfd' ? 'HFD' : 'DSP'}
                              </small>
                            )}
                          </td>
                          <td>{f.kind === 'unity' ? '—' : `${fmt(f.frequency)} Hz`}</td>
                          <td>
                            {f.kind === 'unity'
                              ? '—'
                              : `${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)}`}
                          </td>
                          <td>{f.kind === 'unity' ? '—' : f.q.toFixed(3)}</td>
                          <td>
                            <input
                              aria-label={`Enable filter ${i + 1}`}
                              disabled={tab !== 'Input EQ' && channel.linkedTo !== undefined}
                              type="checkbox"
                              checked={f.enabled}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                w.edit((p) => {
                                  (tab === 'Input EQ'
                                    ? p.presets[w.preset].inputEq
                                    : p.presets[w.preset].channels[w.channel].filters)[i].enabled =
                                    e.target.checked;
                                })
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="table-footer">
                  Signal flows top to bottom{' '}
                  <span>{tab === 'Input EQ' ? '9 input bands' : '15 sections per output'}</span>
                </div>
              </section>
              <fieldset
                className="filter-editor"
                id="selected-filter-inspector"
                ref={inspector}
                aria-label="Selected filter inspector"
                disabled={tab !== 'Input EQ' && channel.linkedTo !== undefined}
              >
                <div className="panel-heading">
                  <h2>
                    {tab === 'Input EQ' ? 'Band' : 'Biquad'}{' '}
                    {String((tab === 'Input EQ' ? eqIndex : w.filter) + 1).padStart(2, '0')}
                  </h2>
                  <button
                    title="Reset selected filter"
                    onClick={() =>
                      tab === 'Input EQ'
                        ? editFilter({ enabled: false, gain: 0 }, true, true)
                        : editFilter({ ...newFilter(), sourceId: filter.sourceId }, true)
                    }
                  >
                    Reset
                  </button>
                </div>
                <div
                  className="inspector-context"
                  title={
                    tab === 'Input EQ' ? 'Input EQ applies to all output channels' : channel.name
                  }
                >
                  <span>{w.slot === 'left' ? 'Left' : 'Right'}</span>
                  <span>P{w.preset + 1}</span>
                  <strong>{tab === 'Input EQ' ? 'Input EQ · all outputs' : channel.name}</strong>
                </div>
                <button className="inspector-shape" onClick={() => openPalette('replace')}>
                  <FilterGlyph kind={filter.kind} />
                  <span>
                    <small>FILTER SHAPE</small>
                    <strong>{FILTER_LABELS[filter.kind]}</strong>
                    <em>Change shape</em>
                  </span>
                </button>
                <div className="exact-filter-type">
                  <label className="field-label">
                    Filter type
                    <select
                      value={filter.kind}
                      onChange={(e) => {
                        const kind = e.target.value as FilterKind;
                        if (kind === 'raw') {
                          editFilter({ kind });
                          setShowRaw(true);
                        } else editFilter({ kind }, true);
                      }}
                    >
                      {Object.entries(FILTER_NAMES)
                        .filter(
                          ([kind]) =>
                            tab !== 'Input EQ' ||
                            ['peak', 'lowshelf2', 'highshelf2'].includes(kind),
                        )
                        .map(([kind, name]) => (
                          <option key={kind} value={kind}>
                            {name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <div className="filter-numbers">
                  {filter.kind !== 'unity' && filter.kind !== 'raw' && (
                    <Numeric
                      begin={beginNumericGesture}
                      end={w.endGesture}
                      label={filter.kind === 'asymmetric' ? 'Zero frequency' : 'Frequency'}
                      contextKey={`${w.slot}:${w.preset}:${w.channel}:${tab}:${filter.id}:${filter.kind}:${documentEpochs[w.slot]}:frequency`}
                      frequencyWheel={tab === 'Input EQ' ? undefined : 'advanced'}
                      inputEqParameter={tab === 'Input EQ' ? 'frequency' : undefined}
                      onInputEqWheel={
                        tab === 'Input EQ'
                          ? (result) =>
                              !result.changed || editFilter({ frequency: result.value }, true)
                          : undefined
                      }
                      frequencyWheelMin={tab === 'Input EQ' ? undefined : 10}
                      frequencyWheelMax={
                        tab === 'Input EQ'
                          ? undefined
                          : plotViews[w.slot].Magnitude.range.frequencyMax
                      }
                      value={filter.frequency}
                      onChange={(frequency) => editFilter({ frequency }, true)}
                      deferTextCommit
                      normalizeText={
                        tab === 'Input EQ'
                          ? undefined
                          : (text, previousValue) =>
                              normalizeHfdManualFrequencyText(text, { previousValue })
                      }
                      unit="Hz"
                      min={tab === 'Input EQ' ? HFD_INPUT_EQ_PROFILE.frequency.min : 10}
                      max={50000}
                      adjustmentBounds={tab === 'Input EQ' ? { min: 1, max: 50000 } : undefined}
                      step={1}
                    />
                  )}
                  {hasQ(filter.kind) && (
                    <Numeric
                      begin={beginNumericGesture}
                      end={w.endGesture}
                      label={filter.kind === 'asymmetric' ? 'Zero Q' : 'Q factor'}
                      contextKey={`${w.slot}:${w.preset}:${w.channel}:${tab}:${filter.id}:${filter.kind}:${documentEpochs[w.slot]}:q`}
                      precision={3}
                      value={filter.q}
                      onChange={(q) => editFilter({ q }, true)}
                      parameterWheel={tab === 'Input EQ' ? undefined : 'q'}
                      inputEqParameter={tab === 'Input EQ' ? 'q' : undefined}
                      onInputEqWheel={
                        tab === 'Input EQ'
                          ? (result) => !result.changed || editFilter({ q: result.value }, true)
                          : undefined
                      }
                      parameterWheelAdditionalGain={
                        tab === 'Input EQ' ? undefined : (channel.additionalGain ?? 0)
                      }
                      onParameterWheel={
                        tab === 'Input EQ'
                          ? undefined
                          : (result, direction) => wheelFilter('q', result, direction)
                      }
                      deferTextCommit
                      normalizeText={
                        tab === 'Input EQ'
                          ? undefined
                          : (text, previousValue) =>
                              normalizeHfdManualQText(text, { previousValue })
                      }
                      formatValue={tab === 'Input EQ' ? undefined : formatHfdManualQValue}
                      min={
                        tab === 'Input EQ' ? HFD_INPUT_EQ_PROFILE.q.min : HFD_MANUAL_Q_BOUNDS.min
                      }
                      max={
                        tab === 'Input EQ' ? HFD_INPUT_EQ_PROFILE.q.max : HFD_MANUAL_Q_BOUNDS.max
                      }
                      adjustmentBounds={{ min: 0.001, max: 100 }}
                      step={0.01}
                    />
                  )}
                  {(filter.kind === 'peak' || filter.kind.includes('shelf')) && (
                    <Numeric
                      begin={beginNumericGesture}
                      end={w.endGesture}
                      label="Filter gain"
                      contextKey={`${w.slot}:${w.preset}:${w.channel}:${tab}:${filter.id}:${filter.kind}:${documentEpochs[w.slot]}:gain`}
                      value={filter.gain}
                      onChange={(gain) => editFilter({ gain }, true)}
                      parameterWheel={tab === 'Input EQ' ? undefined : 'gain'}
                      inputEqParameter={tab === 'Input EQ' ? 'gain' : undefined}
                      onInputEqWheel={
                        tab === 'Input EQ'
                          ? (result) => !result.changed || editFilter({ gain: result.value }, true)
                          : undefined
                      }
                      parameterWheelAdditionalGain={
                        tab === 'Input EQ' ? undefined : (channel.additionalGain ?? 0)
                      }
                      onParameterWheel={
                        tab === 'Input EQ'
                          ? undefined
                          : (result, direction) => wheelFilter('gain', result, direction)
                      }
                      deferTextCommit
                      normalizeText={
                        tab === 'Input EQ'
                          ? undefined
                          : (text, previousValue) =>
                              normalizeHfdManualGainText(text, { previousValue })
                      }
                      formatValue={tab === 'Input EQ' ? undefined : formatHfdManualGainValue}
                      unit="dB"
                      min={
                        tab === 'Input EQ'
                          ? HFD_INPUT_EQ_PROFILE.gain.min
                          : HFD_MANUAL_GAIN_BOUNDS.min
                      }
                      max={
                        tab === 'Input EQ'
                          ? HFD_INPUT_EQ_PROFILE.gain.max
                          : HFD_MANUAL_GAIN_BOUNDS.max
                      }
                      adjustmentBounds={
                        tab === 'Input EQ' ? { min: -32, max: 32 } : { min: -60, max: 60 }
                      }
                      step={0.1}
                    />
                  )}
                </div>
                {filter.kind === 'asymmetric' && (
                  <>
                    <label className="field-label">
                      Shelf direction
                      <select
                        value={filter.shelfDirection ?? 'low'}
                        onChange={(e) =>
                          editFilter({ shelfDirection: e.target.value as 'low' | 'high' }, true)
                        }
                      >
                        <option value="low">Low shelf</option>
                        <option value="high">High shelf</option>
                      </select>
                    </label>
                    <Numeric
                      begin={beginNumericGesture}
                      end={w.endGesture}
                      label="Pole frequency"
                      contextKey={`${w.slot}:${w.preset}:${w.channel}:${tab}:${filter.id}:${documentEpochs[w.slot]}:pole-frequency`}
                      frequencyWheel="advanced"
                      frequencyWheelMin={10}
                      frequencyWheelMax={plotViews[w.slot].Magnitude.range.frequencyMax}
                      value={filter.frequency2}
                      onChange={(frequency2) => editFilter({ frequency2 }, true)}
                      deferTextCommit
                      normalizeText={(text, previousValue) =>
                        normalizeHfdManualFrequencyText(text, { previousValue })
                      }
                      unit="Hz"
                      min={10}
                      max={50000}
                    />
                    <Numeric
                      begin={beginNumericGesture}
                      end={w.endGesture}
                      label="Pole Q"
                      contextKey={`${w.slot}:${w.preset}:${w.channel}:${tab}:${filter.id}:${documentEpochs[w.slot]}:pole-q`}
                      precision={3}
                      value={filter.q2}
                      onChange={(q2) => editFilter({ q2 }, true)}
                      parameterWheel="q"
                      parameterWheelAdditionalGain={channel.additionalGain ?? 0}
                      onParameterWheel={(result, direction) => wheelFilter('q2', result, direction)}
                      deferTextCommit
                      normalizeText={(text, previousValue) =>
                        normalizeHfdManualQText(text, { previousValue })
                      }
                      formatValue={formatHfdManualQValue}
                      min={HFD_MANUAL_Q_BOUNDS.min}
                      max={HFD_MANUAL_Q_BOUNDS.max}
                      adjustmentBounds={{}}
                      step={0.01}
                    />
                  </>
                )}
                <Toggle checked={filter.enabled} onChange={(enabled) => editFilter({ enabled })}>
                  Filter enabled
                </Toggle>
                {filter.kind !== 'raw' && (
                  <button className="raw-button" onClick={() => setShowRaw(!showRaw)}>
                    <Activity size={14} />
                    {showRaw ? 'Hide' : 'Show'} coefficients
                    <ChevronDown size={13} />
                  </button>
                )}
                <div className="inspector-details" ref={inspectorDetails}>
                  {filter.provenance && (
                    <p
                      className="inspector-provenance"
                      title="Changing parameters explicitly redesigns this section."
                    >
                      {filter.provenance === 'hfd'
                        ? 'Original HFD coefficients'
                        : 'Coefficients from amplifier'}
                    </p>
                  )}
                  {designError && <div className="inline-error">{designError}</div>}
                  {(showRaw || filter.kind === 'raw') && coefficients && (
                    <div className="coefficients">
                      {(['b0', 'b1', 'b2', 'f1', 'f2'] as const).map((key) =>
                        filter.kind === 'raw' ? (
                          <Numeric
                            key={key}
                            label={`Coefficient ${key}`}
                            value={coefficients[key]}
                            formatValue={String}
                            deferTextCommit
                            contextKey={`${w.slot}:${w.preset}:${w.channel}:${filter.id}:${documentEpochs[w.slot]}:${channel.coefficientCache ?? 'base'}:${w.linkedEdits}:${key}`}
                            step={0.00000001}
                            begin={beginNumericGesture}
                            end={w.endGesture}
                            onChange={(value) => editFilter({ coefficients: { [key]: value } })}
                          />
                        ) : (
                          <label key={key}>
                            {key}
                            <input
                              aria-label={`Coefficient ${key}`}
                              type="number"
                              value={coefficients[key]}
                              readOnly
                            />
                          </label>
                        ),
                      )}
                      <small>Positive feedback: 1 − f1 z⁻¹ − f2 z⁻²</small>
                    </div>
                  )}
                  <div className="section-preview">
                    <div className="section-label">SELECTED SECTION</div>
                    {sectionPreview.channel ? (
                      <ResponsePlot
                        compact
                        channels={[sectionPreview.channel]}
                        mode={
                          filter.kind.startsWith('allpass') || mode === 'Phase'
                            ? 'Phase'
                            : 'Magnitude'
                        }
                        sum={false}
                        measured={false}
                      />
                    ) : (
                      <p className="inline-error">{sectionPreview.error}</p>
                    )}
                  </div>
                </div>
              </fieldset>
            </div>
          )}
          {tab === 'FIR' && (
            <FirPanel
              preset={preset}
              presetIndex={w.preset}
              selectedOutputIndex={w.channel}
              onReadFir={(result) => {
                const current = useWorkspace.getState();
                if (
                  current.documents !== w.documents ||
                  current.documentRevision !== w.documentRevision ||
                  current.slot !== w.slot ||
                  current.preset !== w.preset
                )
                  throw new Error(
                    'The design changed while reading FIR; read again to apply to the current design.',
                  );
                current.editAt(
                  [w.slot],
                  (project) => applyReadFir(project.presets[w.preset], result),
                  { synchronizeLinks: false },
                );
              }}
              onNativeAction={(action) => {
                try {
                  const current = useWorkspace.getState();
                  if (
                    current.documents !== w.documents ||
                    current.documentRevision !== w.documentRevision ||
                    current.slot !== w.slot ||
                    current.preset !== w.preset ||
                    current.channel !== w.channel
                  )
                    throw new Error('The FIR target changed; select the action again.');
                  current.editAt(
                    current.linkedEdits ? ['left', 'right'] : [current.slot],
                    (project) => applyNativeFirAction(project.presets[current.preset], action),
                    { synchronizeLinks: false },
                  );
                } catch (error) {
                  setError(error instanceof Error ? error.message : String(error));
                }
              }}
              live={selectedLive}
              edit={(fn) =>
                w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) =>
                  fn(p.presets[w.preset]),
                )
              }
              run={run}
              readFile={readFile}
              notice={setNotice}
            />
          )}
          {tab === 'Measurements' && (
            <Measurements
              contextKey={`${w.slot}:${w.preset}:${w.documentRevision ?? 0}`}
              preset={preset}
              selected={w.channel}
              onMeasurementReplaced={() =>
                refreshPhaseMeasurements(w.linkedEdits ? ['left', 'right'] : [w.slot], w.preset, [
                  w.channel,
                ])
              }
              onSelect={(channel) => chooseWorkspace({ channel, filter: 0 })}
              view={measurementView}
              onView={setMeasurementView}
              captureControls={
                audioAccess && (
                  <CapturePanel
                    controller={audioAccess.controller}
                    context={audioAccess.context}
                    target={{ slot: w.slot, preset: w.preset, channel: w.channel }}
                    targetName={channel.name}
                    revision={() => useWorkspace.getState().documentRevision ?? 0}
                    onComplete={() => setMeasurementView('impulse')}
                  />
                )
              }
              calibrationCurve={calibrationCurve}
              onCalibrationCurve={setCalibrationCurve}
              edit={(fn) =>
                w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) =>
                  fn(p.presets[w.preset]),
                )
              }
              readFile={readFile}
              onError={setError}
              nativeCentered={nativeCentered}
              onNativeCentered={setNativeCentered}
              microphone={project.hfdCalibration}
              onMicrophoneLoad={(text, name) => {
                w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) =>
                  loadProjectMicrophone(p, text, name),
                );
                const state = useWorkspace.getState();
                state.rememberHfdCalibration(state.documents[w.slot].hfdCalibration);
              }}
              onMicrophoneUnload={() => {
                w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) =>
                  unloadProjectMicrophone(p),
                );
                useWorkspace.getState().rememberHfdCalibration(undefined);
              }}
              onMicrophoneOptions={(patch) => {
                w.editAt(w.linkedEdits ? ['left', 'right'] : [w.slot], (p) =>
                  setProjectMicrophoneOptions(p, patch),
                );
              }}
            />
          )}
          {tab === 'Device settings' && (
            <div className="page-panel device-settings-page">
              <div className="device-page-heading">
                <h1>Device settings</h1>
                <span>{w.slot === 'left' ? 'Left' : 'Right'} amplifier</span>
              </div>
              <p className="description">
                Hardware settings are read from the connected amplifier. Importing an HFD design
                does not change these controls.
              </p>
              <details className="device-workflow">
                <summary>Device templates · settings and filters</summary>
                <DeviceClonePanel
                  controller={deviceClone}
                  slot={w.slot}
                  connectedRoles={SLOTS.filter((slot) => !!live[slot])}
                  projects={{
                    left: cloneWorkspace.design('left').project,
                    right: cloneWorkspace.design('right').project,
                  }}
                  getContext={() =>
                    (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                  }
                  contextReady={authorityStatus.phase === 'ready'}
                  externalBusy={!!busy}
                  onExportNative={(slot, format) => {
                    const source = cloneWorkspace.design(slot).project;
                    if (format === 'xml')
                      download(
                        `${source.name}-device-template.xml`,
                        exportNativeCloneProject(source),
                        'application/xml',
                      );
                    else
                      downloadBytes(
                        `${source.name}-device-template.zip`,
                        zipFiles(nativeCloneProjectFiles(source)),
                      );
                  }}
                />
              </details>
              <details className="device-workflow">
                <summary>Restore HFD device defaults</summary>
                <DeviceDefaultsPanel
                  controller={deviceDefaults}
                  slot={w.slot}
                  connectedRoles={SLOTS.filter((slot) => !!live[slot])}
                  getContext={() =>
                    (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                  }
                  contextReady={authorityStatus.phase === 'ready'}
                  externalBusy={!!busy}
                />
              </details>
              {selectedLive ? (
                <>
                  <AmplifierConfiguration
                    controller={amplifierModes}
                    slot={w.slot}
                    connectedRoles={SLOTS.filter((slot) => !!live[slot])}
                    getContext={() =>
                      (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                    }
                    contextReady={authorityStatus.phase === 'ready'}
                    externalBusy={!!busy}
                  />
                  <NativeLimiterPanel
                    controller={nativeLimiter}
                    slot={w.slot}
                    connectedRoles={SLOTS.filter((slot) => !!live[slot])}
                    getContext={() =>
                      (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                    }
                    contextReady={authorityStatus.phase === 'ready'}
                    externalBusy={!!busy}
                  />
                  <NativeMixerPanel
                    controller={nativeMixer}
                    slot={w.slot}
                    preset={(w.preset + 1) as 1 | 2 | 3}
                    onPresetChange={(preset) => chooseWorkspace({ preset: preset - 1 })}
                    connectedRoles={SLOTS.filter((slot) => !!live[slot])}
                    getContext={() =>
                      (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                    }
                    contextReady={authorityStatus.phase === 'ready'}
                    externalBusy={!!busy}
                  />
                  <DeviceAuthPanel
                    key={`${w.slot}:${selectedLive.connectionId}`}
                    controller={deviceAuth}
                    slot={w.slot}
                    externalBusy={!!busy}
                    view={authView}
                    onViewChange={setAuthView}
                    refresh={() => adapter.refresh([w.slot])}
                  />
                  <DeviceSettings
                    diagnosticsExpanded={healthDetails}
                    onDiagnosticsExpanded={setHealthDetails}
                    key={`${w.slot}:${selectedLive.identity.serial}:${lastDefaultsResult?.id ?? ''}`}
                    live={selectedLive}
                    controls={controls}
                    operate={operate}
                    refresh={() => adapter.refresh([w.slot])}
                  />
                </>
              ) : (
                <div className="feature-card device-offline">
                  <Cable size={24} />
                  <div>
                    <h2>Connect the {w.slot} amplifier</h2>
                    <p>Choose its USB interface to read settings.</p>
                  </div>
                  <button className="primary" onClick={() => connect(w.slot)}>
                    Connect amplifier
                  </button>
                </div>
              )}
              <FirmwarePanel
                workspace={firmwareWorkspace}
                runtime={firmwareRuntime}
                execution={firmwareExecution}
                getContext={() =>
                  (projectSourceContext.current ??= workspaceAuthority.localContext('ui'))
                }
                contextReady={authorityStatus.phase === 'ready'}
                externalBusy={!!busy}
                slot={w.slot}
                descriptorVerifier={descriptorVerifier}
              />
              <div className="info-box">
                Device writes check fresh permissions and verify their readback. Firmware files can
                be inspected offline. Password and OEM changes use the access panel and report each
                confirmed step. Firmware programming and support-code recovery remain unverified.
              </div>
            </div>
          )}
          {tab === 'Backups' && (
            <div className="page-panel">
              <div className="eyebrow">RECOVERY & PROJECT TOOLS</div>
              <h1>Backups & projects</h1>
              <SourceBrowser
                sources={projectSources}
                opener={projectSourceOpener}
                captureOpen={() => {
                  const current = useWorkspace.getState();
                  return {
                    target: current.linkedEdits ? 'both' : current.slot,
                    expectedRevision: current.documentRevision ?? 0,
                    principal: (projectSourceContext.current ??=
                      workspaceAuthority.localContext('ui')),
                  };
                }}
                onError={setError}
                onOpened={(result) =>
                  setNotice(
                    result.replayed
                      ? 'The previous project open was already saved.'
                      : 'Project opened from its local source.',
                  )
                }
              />
              <ProjectLibrary
                project={project}
                openDisabled={projectSourceOpener.busy || !!projectSourceOpener.pending}
                onSaved={async (record) => {
                  try {
                    await projectSources.rememberLibrary({
                      id: record.id,
                      label: record.name,
                      modifiedAt: Date.parse(record.utc),
                    });
                  } catch (error) {
                    setError(
                      `Snapshot saved; its source reference could not be saved: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                }}
                openSnapshot={async (record) => {
                  const current = useWorkspace.getState(),
                    binding = {
                      target: current.linkedEdits ? ('both' as const) : current.slot,
                      expectedRevision: current.documentRevision ?? 0,
                      principal: (projectSourceContext.current ??=
                        workspaceAuthority.localContext('ui')),
                      requestId: crypto.randomUUID(),
                    };
                  const sourceId = await projectSources.rememberLibrary({
                    id: record.id,
                    label: record.name,
                    modifiedAt: Date.parse(record.utc),
                  });
                  const result = await projectSourceOpener.open({ ...binding, sourceId });
                  if (result.recentWarning) setError(result.recentWarning);
                  setNotice('Project opened from the saved library snapshot.');
                }}
                replace={(p) => {
                  w.replaceAt(w.slot, p);
                  projectViewsReplaced([w.slot]);
                  setNotice(p.warnings.at(-1) ?? 'Project opened from the library.');
                }}
                onError={setError}
              />
              <p className="description">
                Complete 4 KiB flash sectors, bound to the physical amplifier and checked with
                SHA-256. Every upload saves a backup before erase.
              </p>
              <div className="button-row">
                <button
                  disabled={!selectedLive || !!busy}
                  onClick={() =>
                    run('Backing up', async () => {
                      await selectedLive!.session.backup(w.preset + 1);
                      setNotice('Exact flash backup saved.');
                    })
                  }
                >
                  <ShieldCheck size={15} />
                  Back up preset {w.preset + 1}
                </button>
                <button
                  onClick={() =>
                    readFile('.json', (text) => {
                      void run('Restoring backup', async () => {
                        const b = await importBackupFile(text);
                        if (!selectedLive)
                          throw new Error(
                            'Backup imported into the recovery library. Connect the matching amplifier to restore it.',
                          );
                        await selectedLive.session.restore(b, (percent, message) =>
                          setProgress((old) => ({ ...old, [w.slot]: { percent, message } })),
                        );
                        setNotice('Backup restored and read back. Outputs remain muted.');
                      });
                    })
                  }
                >
                  <FolderOpen size={15} />
                  Restore backup file
                </button>
                <button
                  onClick={() => {
                    try {
                      download(`${project.name}-edited.xml`, exportHfd(project), 'application/xml');
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Export HFD XML
                </button>
                <select
                  aria-label="Copy preset to"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== '') {
                      w.copyPreset(Number(e.target.value));
                      e.target.value = '';
                    }
                  }}
                >
                  <option value="" disabled>
                    Copy current preset to…
                  </option>
                  {[0, 1, 2]
                    .filter((i) => i !== w.preset)
                    .map((i) => (
                      <option key={i} value={i}>
                        Preset {i + 1}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() =>
                    designAction(
                      () => w.edit((p) => clearPreset(p, w.preset)),
                      'Preset filters cleared using HFD semantics. Undo restores the design.',
                    )
                  }
                  title="Clear gain, inversion, biquads and input FIR; retain EQ, delays, output FIR, links and measurements"
                >
                  Clear preset filters
                </button>
                <button
                  onClick={() => {
                    w.replaceAt(w.slot, inheritProjectMicrophone(newProject(), project));
                    projectViewsReplaced([w.slot]);
                  }}
                >
                  New project
                </button>
              </div>
              <div className="backup-list">
                {backups.length ? (
                  backups.map((b) => (
                    <div key={b.id} className="backup-row">
                      <ShieldCheck size={20} />
                      <div>
                        <strong>
                          {b.name || 'FA503'} · Preset {b.preset}
                        </strong>
                        <small>
                          {new Date(b.utc).toLocaleString()} · {b.serial}
                        </small>
                        <code>{b.sha256}</code>
                      </div>
                      <button
                        onClick={() =>
                          download(
                            `FA503-p${b.preset}-${b.utc.replace(/[:.]/g, '-')}.backup.json`,
                            JSON.stringify(b, null, 2),
                          )
                        }
                      >
                        <Download size={15} />
                        Export
                      </button>
                      <button
                        disabled={
                          !selectedLive || busy !== '' || selectedLive.identity.serial !== b.serial
                        }
                        onClick={() =>
                          run('Restoring backup', async () => {
                            await selectedLive!.session.restore(b, (percent, message) =>
                              setProgress((old) => ({ ...old, [w.slot]: { percent, message } })),
                            );
                            setNotice(
                              'Original bytes restored and verified. Outputs remain muted.',
                            );
                          })
                        }
                      >
                        Restore
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <ShieldCheck size={32} />
                    <h2>No hardware backups yet</h2>
                    <p>Read a preset or upload a design to save the original bytes first.</p>
                  </div>
                )}
              </div>
            </div>
          )}
          {tab === 'Help' && <HelpAbout onVerification={() => openWorkspaceTab('Verification')} />}
          {tab === 'Verification' && (
            <div className="page-panel">
              <div className="eyebrow">HFD 5.2.4 PARITY</div>
              <h1>Verification ledger</h1>
              <p className="description">
                The target is complete HFD functionality for a pair of FA503s. This ledger
                distinguishes implemented behavior from unfinished interoperability work.
              </p>
              <table className="verification">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Current implementation</th>
                    <th>Hardware evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      'Stereo architecture',
                      'Independent Left/Right projects, USB queues, identities and backups; linked editing and controls; coordinated uploads',
                      'One physical amp available; second-device behavior needs bench validation',
                    ],
                    [
                      'IIR crossover',
                      '3 presets × 3 channels × 15 biquads, gain, delay, polarity, bypass, reorder, free coefficients',
                      'Two older designs uploaded through WebHID; original sector restored and independently verified byte-for-byte',
                    ],
                    [
                      'HFD projects',
                      'Graph-aware XML/folder import; XML/ZIP export; snapshots; staged folder saves, recovery journals and archival; base/effective gain-cache detection',
                      'Generated 12-type project opened and saved in HFD; all nine compiled channel blocks matched exactly',
                    ],
                    [
                      'Filter design',
                      'First/second-order LP, HP, shelf, all-pass, peak and asymmetric filters',
                      'HFD matched-z equations recovered; saved-project coefficient fixtures pass. Boundary and GUI parity testing continues',
                    ],
                    [
                      'Response analysis',
                      'Measured/electrical magnitude, phase, group delay and native-model impulse/step sums; time pan/zoom and fit; WebGL 2 rendering',
                      'Independent FFT/DFT and browser arrival-time fixtures pass. Native FFT endpoints are inferred from code; fresh HFD GUI time fixtures remain pending',
                    ],
                    [
                      'Input EQ',
                      'Nine editable bands; native Default EQ, copy to all designs and three-preset bank transfer',
                      'Default/copy/bank design actions checked in Chrome; backup, paired programming and activation preservation pass simulation. Physical EQ writes pending',
                    ],
                    [
                      'FIR',
                      '4500 input / 1500 per output; read/upload, shared-sector backup and exact recovery manifests',
                      'Reversed Q8.24 taps, preserved tails, EEPROM names and activation tested in simulation; physical validation pending',
                    ],
                    [
                      'Measurements',
                      'Text impulse, WAV and REW response import; FFT, windowing, phase zero, smoothing, magnitude/phase microphone correction, exports',
                      'Offline processing and simulated capture tests pass. Actual recording, sound-card routing and acoustic sweep validation remain pending',
                    ],
                    [
                      'Device settings',
                      'Source, routing, volume, preset, global/channel mute; fresh read-modify-write',
                      'Read/status and retained-settings packet recovered; per-option QA pending',
                    ],
                    [
                      'Recovery',
                      'IndexedDB backups, SHA-256, identity-bound restore, page and full-sector readback',
                      'Fresh read-only verification after HFD closed reports DSP On and the exact original preset1 checksum. No recovery power/configuration write was sent; acoustic output remains unverified.',
                    ],
                    [
                      'Advanced settings',
                      'Limiter calculation, startup/preset offsets, signal detection, standby, routing and master/slave options',
                      'Startup/detection settings restored on hardware. Shared native normal/Expert limiter drafts and reviewed paired updates are implemented; physical limiter/credential writes remain pending and firmware programming is unfinished',
                    ],
                    [
                      'Device Defaults',
                      'Reviewed settings, mixer, limiter and display sequence; coordinated preflight, durable journals and explicit recovery for Left, Right or both',
                      'Native byte mapping and paired simulation pass. Physical Defaults/recovery writes remain unverified; the current original preset1 checksum and DSP On state were checked read-only.',
                    ],
                    [
                      'Device templates',
                      'Typed native templates, atomic connected-device metadata capture, separate physical EQ and staged filter designs, explicit paired review/apply and complete durable recovery records',
                      'Source and synthetic tests only for template writes. No live bridge/configuration test is permitted with the connected drivers. A second physical amplifier is unavailable.',
                    ],
                    [
                      'Native digital mixer',
                      'Conditional OEM StereoDSP editor, three independent preset matrices, native weight formatting and quantization; shared UI/MCP drafts with reviewed Left/Right/Both Save',
                      'Commercial FA503 hides the native editor. Protocol and paired behavior are tested in simulation; physical OEM mixer writes remain unqualified. No manufacturing Enable mixer or bridge write is used.',
                    ],
                    [
                      'Agent access',
                      'WebMCP, authenticated local MCP and private Site commands share browser operations and persistent workspace ownership; older folder-save records require local access review',
                      'Earlier authenticated Site operations passed offline. Current published acceptance awaits sign-in; USB, WebMCP and second-device validation remain separate',
                    ],
                    [
                      'Help and About',
                      'Bundled HFD manual, section links, vendor links and separate application/manual/reference versions; the same resources are available to agents',
                      'Manual identity and General Functions page checked locally; native Help/About GUI and published-browser acceptance remain pending',
                    ],
                  ].map((row) => (
                    <tr key={row[0]}>
                      {row.map((v, i) => (
                        <td key={i}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                WebHID requires desktop Chrome or Edge. macOS, reconnect behavior, a second physical
                amp and audible output verification remain separate test targets. This is an
                independent interoperability project.
              </p>
            </div>
          )}
          <AgentAccess
            adapter={adapter}
            visible={tab === 'Agent access'}
            authority={workspaceAuthority}
          />
        </section>
      </main>
      {persistenceStatus.hydrated && persistenceStatus.error && (
        <div className="persistence-alert" role="alert">
          <strong>Workspace changes are not saved.</strong>
          <span>{persistenceStatus.error}</span>
          <button onClick={() => void retryWorkspacePersistence().catch(() => {})}>
            Retry save
          </button>
          <button
            onClick={() => {
              const text = getWorkspaceRecoveryText();
              if (text) download('fusion-workspace-recovery.json', text);
            }}
          >
            Export recovery data
          </button>
        </div>
      )}
      <footer className="status-bar">
        <div
          className={error ? 'status-message error' : 'status-message'}
          title={error || busy || persistenceStatus.error || notice}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : error ? (
            <X size={14} />
          ) : (
            <span className="status-dot" />
          )}
          {error || busy || persistenceStatus.error || notice}
        </div>
        <div className="master-control">
          <button
            aria-label="Show rotating noise controls"
            aria-pressed={showNoise}
            aria-controls="noise-controls"
            onClick={() => setShowNoise((value) => !value)}
          >
            Noise
          </button>
          {showNoise && (
            <div
              id="noise-controls"
              role="dialog"
              aria-label="Rotating noise controls"
              style={{
                position: 'fixed',
                bottom: 42,
                right: 12,
                width: 520,
                maxWidth: 'calc(100vw - 24px)',
                maxHeight: 'calc(100vh - 96px)',
                overflowY: 'auto',
                zIndex: 90,
              }}
            >
              <button
                aria-label="Close noise controls"
                onClick={() => setShowNoise(false)}
                style={{ float: 'right', position: 'relative', zIndex: 1 }}
              >
                ×
              </button>
              <NoisePanel
                controller={noiseController}
                paused={!!busy}
                onError={setError}
                onResult={(result) =>
                  setNotice(
                    `${result.requested ? 'Noise Start' : 'Noise Stop'} acknowledged. Actual sound state is not read back.`,
                  )
                }
              />
            </div>
          )}
          <button
            aria-label="Show amplifier levels"
            aria-pressed={showMeters}
            onClick={() => setShowMeters((value) => !value)}
          >
            VU
          </button>
          {showMeters && <LiveMeters connections={live} paused={!!busy} />}
          <span>
            {selectedLive ? inputSourceLabel(selectedLive.status.input) : 'Offline design'}
          </span>
          <button
            title="Decrease master volume"
            disabled={!selectedLive || !!busy}
            onClick={() => controls({ volume: selectedLive!.status.volume - 0.5 })}
          >
            −
          </button>
          <div className="master-volume-entry">
            <Numeric
              begin={w.beginGesture}
              end={w.endGesture}
              commitOnly
              label="Master volume"
              contextKey={`${w.slot}:${selectedLive?.connectionId ?? 'offline'}:${selectedLive?.status.preset ?? 0}`}
              value={selectedLive?.status.volume ?? -96}
              unit="dB"
              min={-96}
              max={18}
              step={0.5}
              disabled={!selectedLive || !!busy}
              onChange={(volume) => {
                void controls({ volume });
              }}
            />
          </div>
          <button
            title="Increase master volume"
            disabled={!selectedLive || !!busy}
            onClick={() => controls({ volume: selectedLive!.status.volume + 0.5 })}
          >
            +
          </button>
          <button
            className={selectedLive?.status.muted ? 'mute active' : 'mute'}
            disabled={!selectedLive || !!busy}
            onClick={() => controls({ mute: !selectedLive?.status.muted })}
          >
            {selectedLive?.status.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}{' '}
            {selectedLive?.status.muted ? 'MUTED' : 'MUTE'}
          </button>
        </div>
      </footer>
      {saveDialog && (
        <ProjectSaveDialog
          key={saveDialog.binding.exportId ?? saveDialog.binding.requestId}
          writer={directoryWriter}
          captureBinding={() => saveDialog.binding}
          projectName={saveDialog.project.name}
          initialLegacyReview={saveDialog.legacyReview}
          exportPreparation={
            saveCapture && saveCaptureRole
              ? {
                  phase: saveCapture.phase,
                  slot: saveCaptureRole.slot,
                  source: saveCaptureRole.source,
                  serial: saveCaptureRole.identity?.serial,
                  capturedAt: saveCaptureRole.capturedAt,
                  error: saveCaptureRole.error ?? saveCapture.error,
                  onDesignOnly: saveCaptureRole.source === 'connected' ? saveDesignOnly : undefined,
                  onRetry: retryProjectSaveRead,
                  onCancelRead: closeProjectSave,
                }
              : undefined
          }
          onError={setError}
          onClose={closeProjectSave}
          onSaved={(receipt) =>
            setNotice(
              `${receipt.slot === 'left' ? 'Left' : 'Right'} project saved and verified in ${receipt.folderName}.${receipt.workspaceChanged ? ' Newer edits still need a folder save.' : ''}`,
            )
          }
          onDownloadJson={async () => {
            const artifact = await resolveProjectSave(saveDialog);
            download(
              `${artifact.project.name}.fusion.json`,
              JSON.stringify(artifact.project, null, 2),
            );
          }}
          onDownloadZip={async () => {
            const artifact = await resolveProjectSave(saveDialog);
            downloadBytes(`${artifact.project.name}.zip`, zipFiles([...artifact.files]));
          }}
        />
      )}
      {(Object.entries(progress).length > 0 || uploadReport.length > 0) && (
        <div className="progress-panel">
          <button
            aria-label="Close upload progress"
            className="close-progress"
            onClick={() => {
              setProgress({});
              setUploadReport([]);
            }}
          >
            <X size={14} />
          </button>
          {uploadReport.map((report) => (
            <section
              key={report.label}
              className="upload-result"
              aria-label={`${report.label} upload result`}
            >
              <strong>{report.label} · upload incomplete</strong>
              <div>
                {report.presets.map((p) => (
                  <span key={p.preset} className={p.state} title={p.error}>
                    P{p.preset} {p.state}
                  </span>
                ))}
              </div>
              <small>
                {report.activePresetRestored
                  ? `Starting preset ${report.startingPreset} restored.`
                  : 'Starting preset restoration not confirmed.'}{' '}
                Latest confirmed mute: {report.lastConfirmedMuted ? 'on' : 'unknown/off'}.
              </small>
            </section>
          ))}
          {Object.entries(progress).map(([slot, p]) => (
            <div key={slot}>
              <strong>
                {slot.toUpperCase()} <span>{Math.round(p.percent)}%</span>
              </strong>
              <progress max={100} value={p.percent} />
              <small>{p.message}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
