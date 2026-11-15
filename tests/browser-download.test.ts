// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BROWSER_DOWNLOAD_URL_LIFETIME_MS,
  downloadBrowserBlob,
} from '../src/domain/browser-download';
import { download } from '../src/domain/files';
import { downloadBytes } from '../src/domain/project-io';

const NativeURL = URL;
function nativeModals(...dialogs: HTMLDialogElement[]) {
  const query = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) =>
    selector === 'dialog:modal' ? (dialogs as unknown as NodeListOf<Element>) : query(selector),
  );
}
let created: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
let revoked: ReturnType<typeof vi.fn<(url: string) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  created = vi.fn((_: Blob) => `blob:synthetic/${created.mock.calls.length}`);
  revoked = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static createObjectURL = created;
      static revokeObjectURL = revoked;
    },
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('clicks a connected hidden anchor inside the active open dialog and removes it immediately', () => {
  const modal = document.createElement('dialog'),
    button = document.createElement('button');
  modal.open = true;
  modal.appendChild(button);
  document.body.appendChild(modal);
  button.focus();
  nativeModals(modal);
  let dispatched: HTMLAnchorElement | undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    dispatched = this;
    expect(this.parentElement).toBe(modal);
    expect(this.isConnected).toBe(true);
    expect(this.hidden).toBe(true);
    expect(this.download).toBe('Left · résumé.json');
    expect(this.href).toBe('blob:synthetic/1');
  });
  downloadBrowserBlob('Left · résumé.json', new Blob(['synthetic']));
  expect(dispatched).toBeDefined();
  expect(dispatched!.isConnected).toBe(false);
  expect(document.querySelectorAll('a')).toHaveLength(0);
  expect(revoked).not.toHaveBeenCalled();
  vi.advanceTimersByTime(BROWSER_DOWNLOAD_URL_LIFETIME_MS - 1);
  expect(revoked).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:synthetic/1');
});

it('uses the focused modal rather than another open dialog and never leaves stale hidden links', () => {
  const active = document.createElement('dialog'),
    other = document.createElement('dialog'),
    button = document.createElement('button');
  active.open = other.open = true;
  active.appendChild(button);
  document.body.append(active, other);
  button.focus();
  nativeModals(active, other);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.parentElement).toBe(active);
    expect(document.querySelectorAll('a')).toHaveLength(1);
  });
  downloadBrowserBlob('first.zip', new Blob(['first']));
  downloadBrowserBlob('second.zip', new Blob(['second']));
  expect(document.querySelectorAll('a')).toHaveLength(0);
  vi.advanceTimersByTime(60_000);
  expect(revoked.mock.calls).toEqual([['blob:synthetic/1'], ['blob:synthetic/2']]);
});

it('uses the body when no modal is open and ignores closed dialogs', () => {
  document.body.appendChild(document.createElement('dialog'));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.parentElement).toBe(document.body);
    expect(this.isConnected).toBe(true);
  });
  downloadBrowserBlob('plain.txt', new Blob(['text']));
  expect(document.querySelectorAll('a')).toHaveLength(0);
});

it('prefers a native :modal match over another nonmodal open dialog', () => {
  const modal = document.createElement('dialog'),
    nonmodal = document.createElement('dialog');
  modal.open = nonmodal.open = true;
  document.body.append(modal, nonmodal);
  const query = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) => {
    if (selector === 'dialog:modal') return [modal] as unknown as NodeListOf<Element>;
    return query(selector);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.parentElement).toBe(modal);
  });
  downloadBrowserBlob('native-modal.txt', new Blob(['test']));
  expect(document.querySelectorAll('a')).toHaveLength(0);
});

it('supports an open dialog when the DOM does not implement the :modal selector', () => {
  const modal = document.createElement('dialog');
  modal.open = true;
  document.body.appendChild(modal);
  const query = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) => {
    if (selector === 'dialog:modal') throw new DOMException('Unsupported selector', 'SyntaxError');
    return query(selector);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.parentElement).toBe(modal);
    expect(this.isConnected).toBe(true);
  });
  downloadBrowserBlob('fallback.json', new Blob(['test']));
  expect(document.querySelectorAll('a')).toHaveLength(0);
});

it('cleans the anchor and immediately revokes its Blob URL when click throws', () => {
  const failure = new Error('Synthetic click failure');
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.isConnected).toBe(true);
    throw failure;
  });
  expect(() => downloadBrowserBlob('failed.json', new Blob(['test']))).toThrow(failure);
  expect(document.querySelectorAll('a')).toHaveLength(0);
  expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:synthetic/1');
  expect(vi.getTimerCount()).toBe(0);
});

it('revokes its Blob URL when attachment fails without scheduling a delayed cleanup', () => {
  vi.spyOn(document.body, 'appendChild').mockImplementation(() => {
    throw new Error('Synthetic append failure');
  });
  expect(() => downloadBrowserBlob('failed.zip', new Blob(['test']))).toThrow('append failure');
  expect(document.querySelectorAll('a')).toHaveLength(0);
  expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:synthetic/1');
  expect(vi.getTimerCount()).toBe(0);
});

it('does not leave a link or schedule cleanup when creating the Blob URL fails', () => {
  created.mockImplementation(() => {
    throw new Error('Synthetic URL failure');
  });
  expect(() => downloadBrowserBlob('failed.json', new Blob(['test']))).toThrow('URL failure');
  expect(document.querySelectorAll('a')).toHaveLength(0);
  expect(revoked).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('retains both established text/binary helper filenames, MIME defaults and exact Blob payloads', async () => {
  const links: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    links.push(this.download);
  });
  download('saved.json', '{"name":"é"}');
  const input = Uint8Array.of(0, 255, 128, 1);
  downloadBytes('archive.zip', input);
  input.fill(7);
  download('values.txt', '1\n2\n', 'text/plain');
  expect(links).toEqual(['saved.json', 'archive.zip', 'values.txt']);
  const blobs = created.mock.calls.map(([blob]) => blob);
  expect(blobs.map((b) => b.type)).toEqual(['application/json', 'application/zip', 'text/plain']);
  const read = (blob: Blob) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  const pending = Promise.all(blobs.map(read));
  await vi.runAllTimersAsync();
  const values = await pending;
  expect(new TextDecoder().decode(values[0])).toBe('{"name":"é"}');
  expect(Array.from(values[1])).toEqual([0, 255, 128, 1]);
  expect(new TextDecoder().decode(values[2])).toBe('1\n2\n');
  expect(document.querySelectorAll('a')).toHaveLength(0);
});
