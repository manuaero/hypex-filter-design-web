import { z } from 'zod';
import type { Slot } from '../domain/model';

export const AMPLIFIER_ROLE_PREFERENCES_KEY = 'fusion-studio-amplifier-roles.v1';
export interface AmplifierRolePreferences {
  version: 1;
  autoReconnect: boolean;
  assignments: Record<string, { slot: Slot; source: 'manual' | 'routing' }>;
}
export interface AmplifierRolePreferencesBackend {
  read(): unknown;
  write(value: AmplifierRolePreferences): void;
}
const schema = z
  .object({
    version: z.literal(1),
    autoReconnect: z.boolean(),
    assignments: z
      .record(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[\x20-\x7e]+$/),
        z
          .object({ slot: z.enum(['left', 'right']), source: z.enum(['manual', 'routing']) })
          .strict(),
      )
      .refine((value) => Object.keys(value).length <= 32, 'Too many amplifier assignments'),
  })
  .strict();

export function parseAmplifierRolePreferences(value: unknown): AmplifierRolePreferences {
  return schema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}

export function createBrowserAmplifierRolePreferencesBackend(
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): AmplifierRolePreferencesBackend {
  const current = () => storage ?? window.localStorage;
  return {
    read: () => current().getItem(AMPLIFIER_ROLE_PREFERENCES_KEY),
    write: (value) =>
      current().setItem(
        AMPLIFIER_ROLE_PREFERENCES_KEY,
        JSON.stringify(parseAmplifierRolePreferences(value)),
      ),
  };
}
