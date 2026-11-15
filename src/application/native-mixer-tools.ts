import { z } from 'zod';
import { parseExecutionPrincipal, type ToolExecutionContext } from './execution-context';
import type { NativeMixerController, NativeMixerPreset } from './native-mixer';
import type { FileTransfers, TransferJson, FileTransferStatus } from './file-transfers';

const target = z.enum(['left', 'right', 'both']),
  preset = z.union([z.literal(1), z.literal(2), z.literal(3)]),
  revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id = z.string().uuid();

export const nativeMixerToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('refresh-history') }).strict(),
  z.object({ action: z.literal('load'), target, preset }).strict(),
  z.object({ action: z.literal('open'), target, preset, expectedRevision: revision }).strict(),
  z
    .object({
      action: z.literal('edit'),
      target,
      preset,
      expectedRevision: revision,
      channel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      input: z.enum(['left', 'right']),
      value: z.number().min(-1).max(1),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), target, preset }).strict(),
  z.object({ action: z.literal('review'), target, preset, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('save'), reviewId: id, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('discard-review'), reviewId: id }).strict(),
  z.object({ action: z.literal('export-record'), id }).strict(),
]);

export async function executeNativeMixerTool(
  input: unknown,
  port: {
    controller?: NativeMixerController;
    context?: ToolExecutionContext;
    view(preset?: NativeMixerPreset): void;
    files?: { manager: FileTransfers; revision(): number };
    transferPage(status: FileTransferStatus): unknown;
  },
) {
  const command = nativeMixerToolSchema.parse(input),
    controller = port.controller;
  if (!controller) throw new Error('Native mixer is unavailable in this workspace');
  if (!port.context) throw new Error('Native mixer requires a trusted workspace execution context');
  const context = {
    ...parseExecutionPrincipal({ owner: port.context.owner, scope: port.context.scope }),
    ...(port.context.signal ? { signal: port.context.signal } : {}),
  };
  context.signal?.throwIfAborted();
  const status = () => ({ ok: true, mixer: controller.status(context) });
  if (command.action === 'status') return status();
  if (command.action === 'refresh-history') {
    await controller.refreshHistory(context);
    return status();
  }
  if (command.action === 'load') {
    await controller.load(command.target, context, { preset: command.preset });
    port.view(command.preset);
    return status();
  }
  if (command.action === 'open') {
    controller.open(command.target, context, {
      preset: command.preset,
      expectedRevision: command.expectedRevision,
    });
    port.view(command.preset);
    return status();
  }
  if (command.action === 'edit') {
    controller.edit(command.target, context, {
      preset: command.preset,
      expectedRevision: command.expectedRevision,
      channel: command.channel,
      input: command.input,
      value: command.value,
    });
    port.view(command.preset);
    return status();
  }
  if (command.action === 'cancel') {
    controller.cancel(command.target, context, { preset: command.preset });
    port.view(command.preset);
    return status();
  }
  if (command.action === 'review') {
    const review = await controller.review(command.target, context, {
      preset: command.preset,
      expectedRevision: command.expectedRevision,
    });
    port.view(command.preset);
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
          path: `Mixer-${record.id}.json`,
          blob: new Blob([JSON.stringify(record)], { type: 'application/json' }),
        },
      ],
      {
        workflow: 'native-mixer-recovery',
        parameters: { id: command.id } as TransferJson,
        expectedRevision: port.files.revision(),
      },
    );
    return { ok: true, transfer: port.transferPage(transfer) };
  }
  return { ok: true, result: await controller.save(command.reviewId, context, { confirm: true }) };
}
