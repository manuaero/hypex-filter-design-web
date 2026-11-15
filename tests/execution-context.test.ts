// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  parseExecutionPrincipal,
  sameExecutionPrincipal,
} from '../src/application/execution-context';

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

it('parses detached opaque identity fields without interpreting tool arguments', () => {
  const wire = { owner: 'site:opaque-user', scope: 'lease:opaque-value' },
    parsed = parseExecutionPrincipal(wire);
  expect(parsed).toEqual(wire);
  parsed.owner = 'changed';
  expect(wire.owner).toBe('site:opaque-user');
  expect(sameExecutionPrincipal(wire, { ...wire })).toBe(true);
  expect(sameExecutionPrincipal(wire, { ...wire, owner: 'other' })).toBe(false);
  expect(sameExecutionPrincipal(wire, { ...wire, scope: 'other' })).toBe(false);
});

it.each([
  undefined,
  null,
  [],
  'owner',
  { owner: 'owner' },
  { owner: 'owner', scope: 'scope', signal: {} },
  { owner: '', scope: 'scope' },
  { owner: 'owner', scope: '  ' },
  { owner: 'x'.repeat(513), scope: 'scope' },
  { owner: 'owner', scope: 'x'.repeat(513) },
  { owner: 'owner\nsecond', scope: 'scope' },
  { owner: 'owner', scope: 12 },
  Object.create({ owner: 'owner', scope: 'scope' }),
])('rejects malformed or extended wire context %j', (wire) => {
  expect(() => parseExecutionPrincipal(wire)).toThrow('Invalid trusted execution context');
});

it('keeps the same tab owner after a module reload with separate fresh entry-point scopes', async () => {
  const firstModule = await import('../src/application/execution-context'),
    manual = firstModule.createBrowserExecutionContext('manual'),
    web = firstModule.createBrowserExecutionContext('webmcp'),
    secondManual = firstModule.createBrowserExecutionContext('manual');
  expect(manual.owner).toMatch(/^browser:[a-f\d-]{36}$/);
  expect(web.owner).toBe(manual.owner);
  expect(secondManual.owner).toBe(manual.owner);
  expect(manual.scope).toMatch(/^manual:[a-f\d-]{36}$/);
  expect(web.scope).toMatch(/^webmcp:[a-f\d-]{36}$/);
  expect(new Set([manual.scope, web.scope, secondManual.scope]).size).toBe(3);
  vi.resetModules();
  const reloaded = await import('../src/application/execution-context'),
    afterReload = reloaded.createBrowserExecutionContext('ui');
  expect(afterReload.owner).toBe(manual.owner);
  expect(afterReload.scope).toMatch(/^ui:/);
  expect(afterReload.scope).not.toBe(manual.scope);
});

it('uses a page-memory owner if browser session storage is denied', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage denied');
  });
  const { createBrowserExecutionContext } = await import('../src/application/execution-context'),
    first = createBrowserExecutionContext('manual'),
    second = createBrowserExecutionContext('webmcp');
  expect(first.owner).toMatch(/^browser:[a-f\d-]{36}$/);
  expect(second.owner).toBe(first.owner);
  expect(second.scope).not.toBe(first.scope);
});
