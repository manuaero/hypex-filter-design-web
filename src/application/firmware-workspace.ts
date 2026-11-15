import type { Slot } from '../domain/model';
import type { FirmwareFamily, FirmwareSegment } from '../domain/firmware';
import {
  parseFirmwareBundle,
  describeFirmwarePacketPlan,
  firmwarePacketAt,
  type FirmwareBundle,
} from '../domain/firmware';
import { MAX_UI_TEXT_CHARACTERS, MAX_UI_FILE_BYTES } from './file-budget';
import type { UsbDescriptorProof } from '../hardware/usb-descriptor';

/** Ordinary connected-device identity, NOT a HID descriptor/product serial. */
export interface FirmwareDeviceBinding {
  serial: string;
  core: string;
  firmware: string;
  product?: number;
}
export interface FirmwareUnavailableReason {
  code: string;
  message: string;
}
export interface FirmwareStage {
  id: string;
  name: string;
  sha256: string;
  textBytes: number;
  family: FirmwareFamily;
  /** Uninterpreted native uint32 header metadata, not file sizes or versions. */
  headerWords: readonly [number, number];
  recordCount: number;
  dataBytes: number;
  segmentCount: number;
  segmentsPreview: readonly FirmwareSegment[];
  boundDevice?: FirmwareDeviceBinding;
  bindingChangedDuringInspection: boolean;
  target?: {
    source: 'webusb-descriptor';
    hidSerial: string;
    family: 'FUSION32';
    compatibleWithBundle: boolean;
  };
  plan: {
    recordsPerPass: number;
    packetsPerPass: number;
    totalRecords: number;
    timeoutMs: 4000;
    attempts: 3;
    failedAttemptDelaysMs: readonly [100, 200, 300];
  };
  programming: { available: false; reasons: readonly FirmwareUnavailableReason[] };
}
export interface FirmwareRoleState {
  phase: 'empty' | 'inspecting' | 'ready' | 'error';
  stage?: FirmwareStage;
  pendingName?: string;
  error?: string;
}
export type FirmwareWorkspaceSnapshot = Readonly<Record<Slot, FirmwareRoleState>>;
export interface FirmwarePacketPage {
  slot: Slot;
  stageId: string;
  sha256: string;
  pass: 0 | 1;
  offset: number;
  total: number;
  nextOffset: number | null;
  packets: readonly {
    index: number;
    firstRecord: number;
    recordCount: 1 | 2;
    completedRecords: number;
    /** Exact64-byte native payload as128 lower-case hexadecimal characters. */
    payloadHex: string;
  }[];
}
export interface FirmwareWorkspaceOptions {
  binding: (slot: Slot) => FirmwareDeviceBinding | undefined;
  /** Injectable for deterministic asynchronous hashing tests. */
  sha256?: (bytes: Uint8Array) => Promise<string>;
  /** A proof created by the read-only descriptor verifier; never tool arguments. */
  descriptor?: (slot: Slot) => UsbDescriptorProof | undefined;
}
declare const inspectionTokenBrand: unique symbol;
/** Opaque page-owned token. Serialized or foreign-factory objects are invalid. */
export interface FirmwareInspectionToken {
  readonly [inspectionTokenBrand]: true;
}
export interface FirmwareWorkspace {
  getSnapshot(): FirmwareWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  captureTarget(slot: Slot): FirmwareInspectionToken;
  inspect(
    slot: Slot,
    text: string,
    name: string,
    token?: FirmwareInspectionToken,
  ): Promise<FirmwareStage>;
  clear(slot: Slot): void;
  /** Reconcile metadata only; never changes the originally captured binding. */
  refreshTarget(slot: Slot): void;
  packetPreview(slot: Slot, pass: 0 | 1, offset?: number, limit?: number): FirmwarePacketPage;
}

export const FIRMWARE_SEGMENT_PREVIEW_LIMIT = 20;
export const FIRMWARE_PACKET_PAGE_LIMIT = 50;
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function checkedSlot(slot: Slot): Slot {
  if (slot !== 'left' && slot !== 'right') throw new Error('Choose Left or Right firmware staging');
  return slot;
}
function cloneBinding(value: FirmwareDeviceBinding | undefined): FirmwareDeviceBinding | undefined {
  if (!value) return undefined;
  if (
    ![value.serial, value.core, value.firmware].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 512,
    )
  )
    throw new Error('The current connected-device identity is invalid');
  if (
    value.product !== undefined &&
    (!Number.isInteger(value.product) || value.product < 0 || value.product > 255)
  )
    throw new Error('The current connected-device product code is invalid');
  return immutable({
    serial: value.serial,
    core: value.core,
    firmware: value.firmware,
    ...(value.product === undefined ? {} : { product: value.product }),
  });
}
const blockedReasons = (
  bound: FirmwareDeviceBinding | undefined,
  changed: boolean,
  target?: FirmwareStage['target'],
): FirmwareUnavailableReason[] => [
  ...(!bound
    ? [
        {
          code: 'device-unbound',
          message: 'No ordinary amplifier identity was connected when inspection began.',
        },
      ]
    : []),
  ...(changed
    ? [
        {
          code: 'device-binding-changed',
          message:
            'The amplifier assignment differs from the captured inspection binding; inspect again for the current assignment.',
        },
      ]
    : []),
  ...(!target
    ? [
        {
          code: 'hid-product-serial-unavailable',
          message:
            'A trusted HID product serial is unavailable; EEPROM serial and product name cannot establish the bundle family.',
        },
      ]
    : []),
  ...(target && !target.compatibleWithBundle
    ? [
        {
          code: 'firmware-family-mismatch',
          message: `The observed USB descriptor requires ${target.family}, which differs from this bundle family.`,
        },
      ]
    : []),
  {
    code: 'bootloader-correlation-unavailable',
    message:
      'Bootloader descriptors and reconnect correlation have no implemented, verified adapter.',
  },
  {
    code: 'preservation-unverified',
    message:
      'Preservation of settings, filters and calibration on the actual target is unverified.',
  },
  {
    code: 'recovery-unavailable',
    message: 'Interrupted-update retry and recovery on the actual target are unverified.',
  },
  {
    code: 'writer-unavailable',
    message:
      'Firmware programming is unavailable. This service only inspects files and previews packets.',
  },
];
async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Ephemeral per-role file staging. No device methods or transport are accepted.
 * Parsed originals remain private; public state contains only bounded summaries. */
export function createFirmwareWorkspace(options: FirmwareWorkspaceOptions): FirmwareWorkspace {
  let snapshot: FirmwareWorkspaceSnapshot = immutable({
    left: { phase: 'empty' },
    right: { phase: 'empty' },
  });
  const generations: Record<Slot, number> = { left: 0, right: 0 };
  const bundles: Partial<Record<Slot, FirmwareBundle>> = {};
  const tokens = new WeakMap<
    FirmwareInspectionToken,
    { slot: Slot; binding: FirmwareDeviceBinding | undefined; generation: number }
  >();
  const listeners = new Set<() => void>();
  let targetNotificationQueued = false;
  const publish = (slot: Slot, state: FirmwareRoleState) => {
    snapshot = immutable({ ...snapshot, [slot]: state });
    for (const listener of listeners) listener();
  };
  const currentBinding = (slot: Slot) => {
    try {
      return cloneBinding(options.binding(slot));
    } catch {
      return undefined;
    }
  };
  const targetFor = (
    slot: Slot,
    bound: FirmwareDeviceBinding | undefined,
    family: FirmwareFamily,
  ): FirmwareStage['target'] => {
    if (!bound || JSON.stringify(bound) !== JSON.stringify(currentBinding(slot))) return undefined;
    let proof: UsbDescriptorProof | undefined;
    try {
      proof = options.descriptor?.(slot);
    } catch {
      return undefined;
    }
    if (
      !proof ||
      proof.source !== 'webusb-descriptor' ||
      proof.slot !== slot ||
      proof.vendorId !== 0x345e ||
      proof.productId !== 0x03e8 ||
      proof.family !== 'FUSION32' ||
      proof.hidSerial !== '0303A:' + bound.serial ||
      JSON.stringify(currentBinding(slot)) !== JSON.stringify(bound)
    )
      return undefined;
    try {
      if (JSON.stringify(cloneBinding(proof.binding)) !== JSON.stringify(bound)) return undefined;
    } catch {
      return undefined;
    }
    return {
      source: proof.source,
      hidSerial: proof.hidSerial,
      family: proof.family,
      compatibleWithBundle: proof.family === family,
    };
  };
  const refreshTarget = (slot: Slot, immediate: boolean) => {
    checkedSlot(slot);
    const state = snapshot[slot],
      stage = state.stage;
    if (!stage) return;
    const target = targetFor(slot, stage.boundDevice, stage.family),
      changed =
        stage.bindingChangedDuringInspection ||
        JSON.stringify(stage.boundDevice) !== JSON.stringify(currentBinding(slot)),
      programming = {
        available: false as const,
        reasons: blockedReasons(stage.boundDevice, changed, target),
      };
    if (
      JSON.stringify(stage.target) === JSON.stringify(target) &&
      JSON.stringify(stage.programming) === JSON.stringify(programming)
    )
      return;
    const { target: previousTarget, ...base } = stage;
    void previousTarget;
    snapshot = immutable({
      ...snapshot,
      [slot]: { ...state, stage: { ...base, ...(target ? { target } : {}), programming } },
    });
    if (immediate) for (const listener of listeners) listener();
    else if (!targetNotificationQueued) {
      targetNotificationQueued = true;
      queueMicrotask(() => {
        targetNotificationQueued = false;
        for (const listener of listeners) listener();
      });
    }
  };
  const captureTarget = (slot: Slot): FirmwareInspectionToken => {
    checkedSlot(slot);
    const binding = cloneBinding(options.binding(slot)),
      generation = ++generations[slot];
    const token = Object.freeze({}) as FirmwareInspectionToken;
    tokens.set(token, { slot, binding, generation });
    // A cancelled chooser never leaves a superseded older hash showing busy.
    if (snapshot[slot].phase === 'inspecting')
      publish(
        slot,
        snapshot[slot].stage ? { phase: 'ready', stage: snapshot[slot].stage } : { phase: 'empty' },
      );
    return token;
  };
  return {
    getSnapshot: () => {
      refreshTarget('left', false);
      refreshTarget('right', false);
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    captureTarget,
    inspect: async (slot, text, name, inspectionToken) => {
      checkedSlot(slot);
      if (typeof name !== 'string' || !name.length || name.length > 4096)
        throw new Error('Choose a firmware filename of 1..4096 characters');
      if (typeof text !== 'string' || text.length > MAX_UI_TEXT_CHARACTERS)
        throw new Error('Firmware exceeds the browser text limit');
      const opaque = inspectionToken ?? captureTarget(slot),
        captured = tokens.get(opaque);
      if (!captured || captured.slot !== slot || captured.generation !== generations[slot])
        throw new Error(
          'Firmware inspection target was cleared, superseded, or belongs to another role/workspace',
        );
      tokens.delete(opaque);
      const bound = captured.binding,
        token = captured.generation,
        previous = snapshot[slot].stage;
      publish(slot, {
        phase: 'inspecting',
        pendingName: name,
        ...(previous ? { stage: previous } : {}),
      });
      try {
        const bundle = parseFirmwareBundle(text, name),
          plan = describeFirmwarePacketPlan(bundle),
          bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > MAX_UI_FILE_BYTES)
          throw new Error('Firmware exceeds the browser file-byte budget');
        const hash = await (options.sha256 ?? sha256)(bytes);
        if (token !== generations[slot])
          throw new Error('Firmware inspection was superseded; the file was not staged');
        if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error('Firmware SHA-256 result is invalid');
        const changed =
          JSON.stringify(bound) !== JSON.stringify(cloneBinding(options.binding(slot)));
        const target = targetFor(slot, bound, bundle.family);
        const stage: FirmwareStage = immutable({
          id: `${slot}:${token}:${hash.toLowerCase()}`,
          name,
          sha256: hash.toLowerCase(),
          textBytes: bytes.byteLength,
          family: bundle.family,
          headerWords: [...bundle.headerWords] as [number, number],
          recordCount: bundle.records.length,
          dataBytes: bundle.dataBytes,
          segmentCount: bundle.segments.length,
          segmentsPreview: bundle.segments
            .slice(0, FIRMWARE_SEGMENT_PREVIEW_LIMIT)
            .map((segment) => ({ ...segment })),
          ...(bound ? { boundDevice: bound } : {}),
          bindingChangedDuringInspection: changed,
          ...(target ? { target } : {}),
          plan: {
            recordsPerPass: plan.recordsPerPass,
            packetsPerPass: plan.packetsPerPass,
            totalRecords: plan.totalRecords,
            timeoutMs: plan.timeoutMs,
            attempts: plan.attempts,
            failedAttemptDelaysMs: [...plan.failedAttemptDelaysMs] as [100, 200, 300],
          },
          programming: { available: false, reasons: blockedReasons(bound, changed, target) },
        });
        bundles[slot] = bundle;
        publish(slot, { phase: 'ready', stage });
        return stage;
      } catch (error) {
        if (token !== generations[slot])
          throw new Error('Firmware inspection was superseded; the file was not staged');
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
        publish(slot, {
          phase: 'error',
          ...(previous ? { stage: previous } : {}),
          error: `Inspection of ${JSON.stringify(name)} failed: ${detail}.${previous ? ` Previous staged file ${JSON.stringify(previous.name)} was retained.` : ' No firmware is staged.'}`,
        });
        throw error;
      }
    },
    clear: (slot) => {
      checkedSlot(slot);
      generations[slot]++;
      delete bundles[slot];
      publish(slot, { phase: 'empty' });
    },
    refreshTarget: (slot) => refreshTarget(slot, true),
    packetPreview: (slot, pass, offset = 0, limit = FIRMWARE_PACKET_PAGE_LIMIT) => {
      checkedSlot(slot);
      if (pass !== 0 && pass !== 1) throw new Error('Firmware preview pass must be 0 or 1');
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > FIRMWARE_PACKET_PAGE_LIMIT
      )
        throw new Error('Firmware packet pages require a nonnegative offset and a limit of 1..50');
      const bundle = bundles[slot],
        stage = snapshot[slot].stage;
      if (!bundle || !stage) throw new Error('Inspect a firmware bundle for this role first');
      const total = stage.plan.packetsPerPass;
      if (offset > total) throw new Error('Firmware packet offset exceeds this pass');
      const packets = [];
      for (let index = offset; index < Math.min(offset + limit, total); index++) {
        const packet = firmwarePacketAt(bundle, pass, index);
        packets.push({
          index: packet.index,
          firstRecord: packet.firstRecord,
          recordCount: packet.recordCount,
          completedRecords: packet.completedRecords,
          payloadHex: Array.from(packet.payload, (byte) => byte.toString(16).padStart(2, '0')).join(
            '',
          ),
        });
      }
      return immutable({
        slot,
        stageId: stage.id,
        sha256: stage.sha256,
        pass,
        offset,
        total,
        nextOffset: offset + packets.length < total ? offset + packets.length : null,
        packets,
      });
    },
  };
}
