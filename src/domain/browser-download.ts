/** Retain the Blob while the browser consumes the download asynchronously. */
export const BROWSER_DOWNLOAD_URL_LIFETIME_MS = 60_000;

function downloadHost(): Element {
  let dialogs: Element[];
  try {
    dialogs = Array.from(document.querySelectorAll('dialog:modal'));
  } catch {
    // Older DOM implementations do not expose :modal. An open dialog remains
    // a suitable host there, including in source-only DOM tests.
    dialogs = Array.from(document.querySelectorAll('dialog[open]'));
  }
  const focused = document.activeElement?.closest('dialog[open]');
  return (focused && dialogs.includes(focused) ? focused : dialogs.at(-1)) ?? document.body;
}

/** Request a browser download without navigating or opening a tab. A connected
 * anchor inside the current modal avoids the inert body outside showModal().
 * Returning means click dispatch completed, not that file delivery is proved. */
export function downloadBrowserBlob(name: string, blob: Blob): void {
  if (typeof document === 'undefined' || !document.body)
    throw new Error('Browser downloads require an active document');
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.hidden = true;
    anchor.tabIndex = -1;
    anchor.setAttribute('aria-hidden', 'true');
    // Preserve callers' Unicode filenames. Property assignment does not parse
    // HTML or turn a filename into a navigation URL.
    anchor.download = name;
    anchor.href = url;
    try {
      downloadHost().appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), BROWSER_DOWNLOAD_URL_LIFETIME_MS);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
