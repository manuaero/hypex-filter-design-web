/** Trusted bridge metadata. Never derive this identity from a tool's arguments. */
export interface ExecutionPrincipal {
  owner: string;
  scope: string;
}
export interface ToolExecutionContext extends ExecutionPrincipal {
  signal?: AbortSignal;
}

/** Parse only the identity fields sent by a bridge's authenticated envelope. */
export function parseExecutionPrincipal(value: unknown): ExecutionPrincipal {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'owner') ||
    !Object.hasOwn(value, 'scope')
  )
    throw new Error('Invalid trusted execution context');
  const { owner, scope } = value as Record<string, unknown>;
  for (const part of [owner, scope])
    if (
      typeof part !== 'string' ||
      !part.trim() ||
      part.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(part)
    )
      throw new Error('Invalid trusted execution context');
  return { owner: owner as string, scope: scope as string };
}

export function sameExecutionPrincipal(a: ExecutionPrincipal, b: ExecutionPrincipal): boolean {
  return a.owner === b.owner && a.scope === b.scope;
}

const TAB_OWNER_KEY = 'fusion-studio.execution-owner.v1';
let fallbackTabId: string | undefined;
const uuid = (value: string | null): value is string =>
  value !== null && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

/**
 * Same-tab identity survives reload; each entry point gets a new isolated scope.
 * Storage denial falls back to an identity kept only for this page lifetime.
 */
export function createBrowserExecutionContext(
  kind: 'manual' | 'webmcp' | 'ui',
): ToolExecutionContext {
  let id = fallbackTabId;
  try {
    const saved = sessionStorage.getItem(TAB_OWNER_KEY);
    if (uuid(saved)) id = saved;
    else {
      id ??= crypto.randomUUID();
      sessionStorage.setItem(TAB_OWNER_KEY, id);
    }
  } catch {
    id ??= crypto.randomUUID();
  }
  fallbackTabId = id;
  return { owner: `browser:${id}`, scope: `${kind}:${crypto.randomUUID()}` };
}
