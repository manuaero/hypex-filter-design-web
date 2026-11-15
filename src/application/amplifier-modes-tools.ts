import { z } from 'zod';
import type { ToolExecutionContext } from './execution-context';
import { parseExecutionPrincipal } from './execution-context';
import type { AmplifierModesController } from './amplifier-modes';

const target = z.enum(['left', 'right', 'both']),
  revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id = z.string().uuid();
export const amplifierModesToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('load'), target }).strict(),
  z
    .object({
      action: z.literal('edit'),
      target,
      expectedRevision: revision,
      patch: z
        .object({
          master: z.boolean().optional(),
          bridge: z.boolean().optional(),
          softClip: z.boolean().optional(),
        })
        .strict()
        .refine((p) => Object.keys(p).length > 0, 'Choose at least one mode'),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), target }).strict(),
  z.object({ action: z.literal('review'), target, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('apply'), reviewId: id, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal('discard-review'), reviewId: id }).strict(),
]);
export async function executeAmplifierModesTool(
  input: unknown,
  port: { controller?: AmplifierModesController; context?: ToolExecutionContext; view(): void },
) {
  const command = amplifierModesToolSchema.parse(input),
    controller = port.controller;
  if (!controller) throw new Error('Amplifier configuration is unavailable in this workspace');
  if (!port.context)
    throw new Error('Amplifier configuration requires a trusted workspace execution context');
  const context = {
    ...parseExecutionPrincipal({ owner: port.context.owner, scope: port.context.scope }),
    ...(port.context.signal ? { signal: port.context.signal } : {}),
  };
  context.signal?.throwIfAborted();
  if (command.action === 'status') return { ok: true, configuration: controller.status(context) };
  if (command.action === 'load') {
    await controller.load(command.target, context);
    port.view();
    return { ok: true, configuration: controller.status(context) };
  }
  if (command.action === 'edit') {
    controller.edit(command.target, context, {
      expectedRevision: command.expectedRevision,
      patch: command.patch,
    });
    port.view();
    return { ok: true, configuration: controller.status(context) };
  }
  if (command.action === 'cancel') {
    controller.cancel(command.target, context);
    return { ok: true, configuration: controller.status(context) };
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
    return { ok: true };
  }
  return { ok: true, result: await controller.apply(command.reviewId, context, { confirm: true }) };
}
