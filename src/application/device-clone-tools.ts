import { z } from 'zod';
import type { ToolExecutionContext } from './execution-context';
import { parseExecutionPrincipal } from './execution-context';
import {
  deviceCloneSnapshotPage,
  deviceCloneRecordSummary,
  type DeviceCloneController,
} from './device-clone';
import type { FileTransfers, TransferJson, FileTransferStatus } from './file-transfers';

const target = z.enum(['left', 'right', 'both']);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().uuid();
export const deviceCloneToolSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      offset: revision.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  z.object({ action: z.literal('refresh-history') }).strict(),
  z.object({ action: z.literal('reload'), target }).strict(),
  z
    .object({
      action: z.literal('overrides'),
      target,
      expectedRevision: revision,
      overrides: z
        .object({
          mode: z.enum(['master', 'slave']),
          presets: z
            .array(
              z
                .object({
                  forceInput: z.number().int().min(0).max(7),
                  sourceLock: z.boolean(),
                  volumeLock: z.boolean(),
                })
                .strict(),
            )
            .length(3),
        })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal('review'), target, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('apply'), reviewId: id, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('discard-review'), reviewId: id }).strict(),
  z.object({ action: z.literal('export-record'), id }).strict(),
]);

interface CloneToolPort {
  controller?: DeviceCloneController;
  context?: ToolExecutionContext;
  view(): void;
  files?: { manager: FileTransfers; revision(): number };
  transferPage(status: FileTransferStatus): unknown;
}

/** Every entry point uses the same reviewed controller; no USB packets come from tool arguments. */
export async function executeDeviceCloneTool(input: unknown, port: CloneToolPort) {
  const command = deviceCloneToolSchema.parse(input),
    controller = port.controller;
  if (!controller) throw new Error('Device Clone is unavailable in this workspace');
  if (!port.context) throw new Error('Device Clone requires a trusted workspace execution context');
  const context = {
    ...parseExecutionPrincipal({ owner: port.context.owner, scope: port.context.scope }),
    ...(port.context.signal ? { signal: port.context.signal } : {}),
  };
  context.signal?.throwIfAborted();
  const status = () => ({
    ok: true,
    clone: deviceCloneSnapshotPage(
      controller.status(context),
      command.action === 'status' ? command.offset : undefined,
      command.action === 'status' ? command.limit : undefined,
    ),
  });
  if (command.action === 'status') return status();
  if (command.action === 'refresh-history') {
    await controller.hydrate(context);
    return status();
  }
  if (command.action === 'reload') {
    await controller.reload(command.target, context);
    port.view();
    return status();
  }
  if (command.action === 'overrides') {
    controller.editOverrides(command.target, context, {
      expectedRevision: command.expectedRevision,
      overrides: command.overrides,
    });
    port.view();
    return status();
  }
  if (command.action === 'review') {
    const review = await controller.review(command.target, context, {
      expectedRevision: command.expectedRevision,
    });
    port.view();
    return { ok: true, review };
  }
  if (command.action === 'discard-review') {
    controller.discard(command.reviewId, context);
    return status();
  }
  if (command.action === 'export-record') {
    if (!port.files) throw new Error('File transfer storage is unavailable in this client');
    const record = controller.exportRecord(command.id, context);
    const transfer = await port.files.manager.createExport(
      context,
      [
        {
          path: `Clone-${record.id}.json`,
          blob: new Blob([JSON.stringify(record)], { type: 'application/json' }),
        },
      ],
      {
        workflow: 'device-clone-recovery',
        parameters: { id: command.id } as TransferJson,
        expectedRevision: port.files.revision(),
      },
    );
    return { ok: true, transfer: port.transferPage(transfer) };
  }
  const record = await controller.apply(command.reviewId, context, { confirm: true });
  return { ok: true, record: deviceCloneRecordSummary(record) };
}
