import type { DeviceDefaultsSnapshot } from './device-defaults';
import type { DefaultsJournalRecord } from './device-defaults-storage';

/** Metadata only. Exact before-images and packets require explicit export. */
export function deviceDefaultsRecordSummary(record: DefaultsJournalRecord) {
  return {
    id: record.id,
    operation: record.operation,
    target: record.target,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.sourceRecordId ? { sourceRecordId: record.sourceRecordId } : {}),
    ...(record.error ? { error: record.error.slice(0, 512) } : {}),
    roles: record.roles.map((role) => ({
      slot: role.slot,
      identity: { ...role.identity },
      preflight: role.preflight,
      lastConfirmedMuted: role.lastConfirmedMuted,
      ...(role.error ? { error: role.error.slice(0, 512) } : {}),
      steps: role.steps.map((step) => ({
        id: step.id,
        state: step.state,
        attempted: step.attempted,
        ...(step.error ? { error: step.error.slice(0, 512) } : {}),
      })),
    })),
  };
}

export function deviceDefaultsSnapshotPage(
  snapshot: Readonly<DeviceDefaultsSnapshot>,
  offset = 0,
  limit = 10,
) {
  return {
    phase: snapshot.phase,
    busy: snapshot.busy,
    ...(snapshot.error ? { error: snapshot.error.slice(0, 512) } : {}),
    ...(snapshot.activeReview ? { activeReview: structuredClone(snapshot.activeReview) } : {}),
    records: snapshot.records.slice(offset, offset + limit).map(deviceDefaultsRecordSummary),
    totalRecords: snapshot.records.length,
    offset,
    nextOffset: offset + limit < snapshot.records.length ? offset + limit : null,
  };
}
