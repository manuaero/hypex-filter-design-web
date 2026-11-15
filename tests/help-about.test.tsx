// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HelpAbout from '../src/components/HelpAbout';
import { createHelpResources, HELP_RESOURCES } from '../src/application/help-resources';
import packageMetadata from '../package.json';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('offers the exact bundled manual, page-2 fallback and official links without opening or fetching them', async () => {
  const fetch = vi.fn(() => {
      throw new Error('Help must not fetch resources on mount');
    }),
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<HelpAbout resources={createHelpResources(true)} onVerification={vi.fn()} />),
  );
  const anchors = [...host.querySelectorAll<HTMLAnchorElement>('a')];
  expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
    HELP_RESOURCES.manual.url,
    HELP_RESOURCES.manual.downloadUrl,
    HELP_RESOURCES.manual.generalUrl,
    ...HELP_RESOURCES.vendors.map((vendor) => vendor.url),
  ]);
  expect(anchors[1].download).toBe(HELP_RESOURCES.manual.fileName);
  expect(anchors[2].getAttribute('href')).toBe('/help/hfdhelp-v3.pdf#page=2');
  expect(anchors[2].textContent).toContain('General · page 2');
  for (const anchor of anchors.filter((anchor) => anchor.target === '_blank')) {
    expect(anchor.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  }
  expect(host.textContent).toContain(HELP_RESOURCES.manual.fallbackReason);
  expect(fetch).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('labels the sourced app version separately from the referenced HFD software and retains the ledger action', async () => {
  const verification = vi.fn();
  await act(async () => root.render(<HelpAbout onVerification={verification} />));
  const facts = [...host.querySelectorAll('dl > div')].map((row) => row.textContent);
  expect(facts).toEqual([`App version${packageMetadata.version}`]);
  expect(host.textContent).toContain('Reference: 38 pages · HFD 5.2.4.24');
  expect(host.textContent).toContain('independent Hypex FusionAmp interoperability project');
  expect(verification).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(verification).toHaveBeenCalledExactlyOnceWith();
});

it('does not invent an alternative ledger action when the embedding client has no callback', async () => {
  await act(async () => root.render(<HelpAbout />));
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  expect(host.querySelectorAll('a')).toHaveLength(HELP_RESOURCES.manual.bundled ? 5 : 3);
});

it('omits unavailable local PDF links and clearly offers official resources without a network probe', async () => {
  const fetch = vi.fn(() => {
      throw new Error('No availability fetch');
    }),
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<HelpAbout resources={createHelpResources(false)} />));
  expect(host.textContent).toContain('optional HFD PDF is not included in this build');
  expect(host.querySelector('a[href^="/help/"]')).toBeNull();
  expect([...host.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
    'https://www.hypex.nl/',
    ...HELP_RESOURCES.vendors.map((vendor) => vendor.url),
  ]);
  expect(host.querySelector('a[download]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
