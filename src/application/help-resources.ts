import packageInfo from '../../package.json';

function immutable<const T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

/** Fixed reference metadata; the Boolean records this build's optional local asset. */
export function createHelpResources(bundledManual: boolean) {
  return immutable({
    app: {
      name: 'Fusion Studio',
      version: packageInfo.version,
      versionSource: 'package.json',
      independent: true,
    },
    manual: {
      id: 'hfd-manual',
      title: 'Hypex Filter Design Manual V3',
      optional: true,
      bundled: bundledManual,
      fallbackUrl: 'https://www.hypex.nl/',
      version: 3,
      url: '/help/hfdhelp-v3.pdf',
      downloadUrl: '/help/hfdhelp-v3.pdf',
      generalUrl: '/help/hfdhelp-v3.pdf#page=2',
      fileName: 'hfdhelp.pdf',
      pageCount: 38,
      bytes: 2_159_767,
      sha256: 'd330afbfd5502aff3d3a305144a0b82e2c371b068bc542e9a77ef5fb76989db6',
      nativeSoftwareVersion: '5.2.4.24',
      nativeRequestedDestination: 'General',
      resolvedGeneralPage: 2,
      fallbackReason:
        'The installed PDF has no named destination General. Its General Functions outline opens page 2.',
      provenance:
        'Reference: unchanged help PDF supplied with Hypex Filter Design 5.2.4.24. The local PDF is optional.',
    },
    vendors: [
      { id: 'hypex', title: 'Hypex', url: 'https://www.hypex.nl/' },
      { id: 'diyclassd', title: 'DIYclassD', url: 'https://www.diyclassd.com/' },
    ],
  });
}
/** Next config derives this flag from the actual optional file before bundling.
 * Outside a Next build, unavailable/unknown defaults to the official fallback. */
function bundledManual(): boolean {
  // Keep the direct reference for Next/esbuild compile-time replacement. The
  // unbundled module also remains safe in runtimes without a Node process.
  try {
    return process.env.NEXT_PUBLIC_HFD_MANUAL_BUNDLED === 'true';
  } catch {
    return false;
  }
}
export const HELP_RESOURCES = createHelpResources(bundledManual());
export type HelpResources = typeof HELP_RESOURCES;

export function getHelpResources(): HelpResources {
  return HELP_RESOURCES;
}
