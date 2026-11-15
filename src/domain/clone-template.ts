import { z } from 'zod';

const finite = z.number().finite();
const byte = finite.int().min(0).max(255);
const word = finite.int().min(0).max(65535);
const int32 = finite
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);
const text = z.string().max(65535);
const triple = <T extends z.ZodType>(schema: T) => z.array(schema).length(3);
const fir = z.strictObject({ loaded: z.boolean(), filename: text, enabled: z.boolean() });
const limiter = z.strictObject({
  threshold: finite,
  attack: finite,
  release: finite,
  ohms: finite,
  watts: finite,
});
const preset = z.strictObject({
  forceInput: byte,
  volumeOffset: finite,
  adcDigitalOut: z.boolean(),
  sourceLock: z.boolean(),
  volumeLock: z.boolean(),
  eqEnabled: z.boolean(),
  application: byte,
  inputFir: fir,
  outputFirs: triple(fir),
});
const eqBand = z.strictObject({
  filterType: finite.int().min(-128).max(127),
  enabled: z.boolean(),
  frequency: finite,
  q: finite,
  gain: finite,
});
export const NATIVE_CLONE_CAPTURE_DEFAULT_FIELDS = [
  'device.bundleVersion',
  'device.bootloaderVersion',
  'settings.gainCorrection12',
  'settings.gainCorrection3',
  'settings.routing',
  'settings.presets.0.inputFir.filename',
  'settings.presets.1.inputFir.filename',
  'settings.presets.2.inputFir.filename',
  'settings.presets.0.outputFirs.0.filename',
  'settings.presets.0.outputFirs.1.filename',
  'settings.presets.0.outputFirs.2.filename',
  'settings.presets.1.outputFirs.0.filename',
  'settings.presets.1.outputFirs.1.filename',
  'settings.presets.1.outputFirs.2.filename',
  'settings.presets.2.outputFirs.0.filename',
  'settings.presets.2.outputFirs.1.filename',
  'settings.presets.2.outputFirs.2.filename',
] as const;
export type NativeCloneCaptureDefaultField = (typeof NATIVE_CLONE_CAPTURE_DEFAULT_FIELDS)[number];

/** Captured native info is separate from the three editable filter designs. */
export const nativeCloneTemplateSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.strictObject({
    kind: z.enum(['hfd-project', 'device-capture']),
    sourceSerial: text,
    capturedAt: z.string().datetime().optional(),
    /** Proven native fresh-host defaults, explicitly not read from the amplifier. */
    captureDefaults: z
      .array(z.enum(NATIVE_CLONE_CAPTURE_DEFAULT_FIELDS))
      .max(17)
      .refine(
        (values) => new Set(values).size === values.length,
        'Duplicate Clone capture default field',
      )
      .optional(),
  }),
  configuration: z.strictObject({
    valid: z.boolean(),
    hypexName: text,
    oemName: text,
    serialNumber: text,
    amplifier: int32,
    thirdChannelEnabled: z.boolean(),
    fanConnected: z.boolean(),
    mixerEnabled: z.boolean(),
    moduleType: byte,
    detectedHardware: int32,
    temperatureSetpoint: int32,
    dspPeakSetpoint: int32,
    mixer: triple(z.array(finite).length(6)),
    limiter: triple(limiter),
  }),
  device: z.strictObject({
    product: byte,
    version: byte,
    build: byte,
    bootloaderMode: z.boolean(),
    dspFilename: text,
    bundleVersion: text,
    unitBehaviour: byte,
    digitalInputPresent: z.boolean(),
    testFirmware: z.boolean(),
    subSetup: byte,
    presetCount: byte,
    channelCount: byte,
    bootloaderVersion: byte,
  }),
  settings: z.strictObject({
    activeInput: byte,
    forcedInput: byte,
    actualVolume: finite,
    passwordProtected: z.boolean(),
    digitalChannelSelect: byte,
    mfbEnabled: z.boolean(),
    presets: triple(preset),
    startupVolume: finite,
    standbyMode: byte,
    gainCorrection12: finite,
    gainCorrection3: finite,
    protectionMask: finite.int().min(0).max(0xffffffff),
    detectionOn: byte,
    detectionOff: byte,
    oledBrightness: byte,
    systemSetup: byte,
    selectedPreset: byte,
    muted: z.boolean(),
    options: word,
    advancedOptions: byte,
    powerOffTime: byte,
    routing: z.array(byte).length(6),
    bundleBcdMajor: word,
    bundleBcdMinor: word,
    controlBundleVersion: text,
  }),
  eqBanks: triple(z.array(eqBand).length(9)),
  /** Original info subtree only, retaining unrecognised native fields/attributes. */
  unknownInfoXml: z
    .string()
    .max(1_000_000)
    .refine(
      (xml) => /^<info(?:\s|\/?>)/.test(xml) && !/<!DOCTYPE|<!ENTITY/i.test(xml),
      'Clone unknownInfoXml must contain one info element without entities or DOCTYPE',
    )
    .optional(),
});
export type NativeCloneTemplate = z.infer<typeof nativeCloneTemplateSchema>;
export type NativeCloneProvenance = Pick<NativeCloneTemplate['provenance'], 'kind' | 'capturedAt'>;

const configurationFields = {
  valid: 'valid',
  hypexName: 'hypexname',
  oemName: 'oemname',
  serialNumber: 'serialnumber',
  amplifier: 'configuredamplifier',
  thirdChannelEnabled: 'thirdchannelenabled',
  fanConnected: 'fanconnected',
  mixerEnabled: 'mixerenabled',
  moduleType: 'configuredmoduletype',
  detectedHardware: 'detectedhardware',
  temperatureSetpoint: 'tempsetpoint',
  dspPeakSetpoint: 'dsppeaksetpoint',
} as const;
const deviceFields = {
  product: 'productnr',
  version: 'versionnr',
  build: 'buildnr',
  bootloaderMode: 'bootldrmode',
  dspFilename: 'dspfilename',
  bundleVersion: 'bundleversion',
  unitBehaviour: 'unitbehaviour',
  digitalInputPresent: 'diginpresent',
  testFirmware: 'testfirmware',
  subSetup: 'subsetup',
  presetCount: 'nrofpresets',
  channelCount: 'nrofchannels',
  bootloaderVersion: 'btldrversion',
} as const;
const settingsFields = {
  activeInput: 'activeinput',
  forcedInput: 'forcedinput',
  actualVolume: 'actualvolume',
  passwordProtected: 'passwdprot',
  digitalChannelSelect: 'digitalchannelselect',
  mfbEnabled: 'mfbenabled',
  startupVolume: 'startvolume',
  standbyMode: 'stdbymode',
  gainCorrection12: 'gainfactch12',
  gainCorrection3: 'gainfactch3',
  protectionMask: 'protmask',
  detectionOn: 'detlevon',
  detectionOff: 'detlevoff',
  oledBrightness: 'oledbrightness',
  systemSetup: 'syssetup',
  selectedPreset: 'selectedpreset',
  muted: 'muted',
  options: 'options',
  advancedOptions: 'advoptions',
  powerOffTime: 'pwrofftime',
  bundleBcdMajor: 'bcdmajor',
  bundleBcdMinor: 'bcdminor',
  controlBundleVersion: 'ctlbundleversion',
} as const;
const presetFields = {
  forceInput: 'forceinput',
  volumeOffset: 'volumeoffset',
  adcDigitalOut: 'aoenable',
  sourceLock: 'sourcelock',
  volumeLock: 'volumelock',
  eqEnabled: 'eqenable',
  application: 'apptype',
} as const;
const mixerFields = ['gch1l', 'gch1r', 'gch2l', 'gch2r', 'gch3l', 'gch3r'] as const;
const boolFields = new Set([
  'valid',
  'thirdChannelEnabled',
  'fanConnected',
  'mixerEnabled',
  'bootloaderMode',
  'digitalInputPresent',
  'testFirmware',
  'passwordProtected',
  'mfbEnabled',
  'muted',
  'adcDigitalOut',
  'sourceLock',
  'volumeLock',
  'eqEnabled',
]);
const stringFields = new Set([
  'hypexName',
  'oemName',
  'serialNumber',
  'dspFilename',
  'bundleVersion',
  'controlBundleVersion',
]);

function xmlDocument(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Clone XML entities and DOCTYPE are not supported');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid Clone XML');
  return doc;
}
function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => child.tagName === name);
}
function single(parent: Element, name: string): Element {
  const matches = children(parent, name);
  if (matches.length !== 1) throw new Error(`Expected one Clone ${name}`);
  return matches[0];
}
function scalar(parent: Element, name: string): string {
  const value = single(parent, name).getAttribute('value');
  if (value === null) throw new Error(`Missing Clone ${name} value`);
  return value;
}
function numeric(parent: Element, name: string): number {
  const value = scalar(parent, name);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    throw new Error(`Invalid Clone ${name} number`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid Clone ${name} number`);
  return number;
}
function boolean(parent: Element, name: string): boolean {
  const value = scalar(parent, name);
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid Clone ${name} boolean`);
  return value === 'true';
}
function readFields(parent: Element, mapping: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, tag]) => [
      key,
      boolFields.has(key)
        ? boolean(parent, tag)
        : stringFields.has(key)
          ? scalar(parent, tag)
          : numeric(parent, tag),
    ]),
  );
}
function indexed(parent: Element, name: string, count: number): Element[] {
  const nodes = children(parent, name);
  if (nodes.length !== count) throw new Error(`Expected ${count} Clone ${name} records`);
  return Array.from({ length: count }, (_, index) => {
    const matching = nodes.filter((node) => node.getAttribute('index') === String(index + 1));
    if (matching.length !== 1)
      throw new Error(`Missing or duplicate Clone ${name} index ${index + 1}`);
    return matching[0];
  });
}
function readFir(parent: Element, output?: number) {
  const suffix = output === undefined ? 'inputfir' : `firch${output + 1}`;
  return {
    loaded: boolean(parent, `${suffix}loaded`),
    filename: scalar(
      parent,
      output === undefined ? 'inputfirfilename' : `outputfirch${output + 1}filename`,
    ),
    enabled: boolean(parent, `${suffix}enable`),
  };
}

/** Missing info remains absent. A populated but malformed snapshot is never fabricated. */
export function parseNativeCloneInfo(
  xml: string,
  provenance: NativeCloneProvenance = { kind: 'hfd-project' },
): NativeCloneTemplate | undefined {
  if (xml.length > 20_000_000) throw new Error('Clone XML exceeds 20 million characters');
  const doc = xmlDocument(xml);
  const root = doc.documentElement;
  const nodes =
    root.tagName === 'info' ? [root] : Array.from(doc.querySelectorAll('project > device > info'));
  if (!nodes.length) return undefined;
  if (nodes.length !== 1) throw new Error('Expected one Clone info snapshot');
  const info = nodes[0];
  // Browser HFD exports historically add an equalizer-only info block. It is
  // not a captured hardware snapshot and must remain an ordinary valid project.
  if (!children(info, 'valid').length) return undefined;
  const configuration = readFields(info, configurationFields);
  const limiterNode = single(info, 'limiter');
  const equalizer = single(info, 'equalizer');
  return nativeCloneTemplateSchema.parse({
    version: 1,
    provenance: { ...provenance, sourceSerial: configuration.serialNumber },
    configuration: {
      ...configuration,
      mixer: indexed(info, 'mixer', 3).map((node) =>
        mixerFields.map((name) => numeric(node, name)),
      ),
      limiter: Array.from({ length: 3 }, (_, ch) => ({
        threshold: numeric(limiterNode, `thch${ch + 1}`),
        attack: numeric(limiterNode, `attackch${ch + 1}`),
        release: numeric(limiterNode, `releasech${ch + 1}`),
        ohms: numeric(limiterNode, `impedancech${ch + 1}`),
        watts: numeric(limiterNode, `powerch${ch + 1}`),
      })),
    },
    device: readFields(info, deviceFields),
    settings: {
      ...readFields(info, settingsFields),
      routing: Array.from({ length: 6 }, (_, index) => numeric(info, `routingch${index + 1}`)),
      presets: indexed(info, 'preset', 3).map((node) => ({
        ...readFields(node, presetFields),
        inputFir: readFir(node),
        outputFirs: Array.from({ length: 3 }, (_, ch) => readFir(node, ch)),
      })),
    },
    eqBanks: indexed(equalizer, 'preset', 3).map((node) =>
      indexed(node, 'filter', 9).map((band) => ({
        filterType: numeric(band, 'filterType'),
        enabled: boolean(band, 'enabled'),
        frequency: numeric(band, 'frequency'),
        q: numeric(band, 'qparam'),
        gain: numeric(band, 'gain'),
      })),
    ),
    unknownInfoXml: new XMLSerializer().serializeToString(info),
  });
}

/** Writes metadata only; this never substitutes project EQ or changes a design. */
export function writeNativeCloneInfo(input: NativeCloneTemplate): string {
  const template = nativeCloneTemplateSchema.parse(input);
  const doc = xmlDocument(template.unknownInfoXml ?? '<info/>');
  const info = doc.documentElement;
  if (info.tagName !== 'info')
    throw new Error('Clone unknownInfoXml must contain one info element');
  const ensure = (parent: Element, name: string, index?: number): Element => {
    const matching = children(parent, name).filter(
      (node) => index === undefined || node.getAttribute('index') === String(index),
    );
    if (matching.length > 1) throw new Error(`Duplicate Clone ${name}`);
    const node = matching[0] ?? doc.createElement(name);
    if (!node.parentNode) parent.appendChild(node);
    if (index !== undefined) node.setAttribute('index', String(index));
    return node;
  };
  const set = (parent: Element, name: string, value: unknown) =>
    ensure(parent, name).setAttribute('value', String(value));
  const writeFields = (parent: Element, mapping: Record<string, string>, values: object) => {
    for (const [key, tag] of Object.entries(mapping))
      set(parent, tag, (values as Record<string, unknown>)[key]);
  };
  writeFields(info, configurationFields, template.configuration);
  writeFields(info, deviceFields, template.device);
  writeFields(info, settingsFields, template.settings);
  template.configuration.mixer.forEach((values, index) => {
    const node = ensure(info, 'mixer', index + 1);
    mixerFields.forEach((name, ch) => set(node, name, values[ch]));
  });
  const limiterNode = ensure(info, 'limiter');
  template.configuration.limiter.forEach((values, ch) => {
    for (const [key, prefix] of Object.entries({
      threshold: 'thch',
      attack: 'attackch',
      release: 'releasech',
      ohms: 'impedancech',
      watts: 'powerch',
    }))
      set(limiterNode, `${prefix}${ch + 1}`, values[key as keyof typeof values]);
  });
  template.settings.routing.forEach((value, index) => set(info, `routingch${index + 1}`, value));
  template.settings.presets.forEach((values, index) => {
    const node = ensure(info, 'preset', index + 1);
    writeFields(node, presetFields, values);
    const writeFir = (values: z.infer<typeof fir>, output?: number) => {
      const prefix = output === undefined ? 'inputfir' : `firch${output + 1}`;
      set(node, `${prefix}loaded`, values.loaded);
      set(node, `${prefix}enable`, values.enabled);
      set(
        node,
        output === undefined ? 'inputfirfilename' : `outputfirch${output + 1}filename`,
        values.filename,
      );
    };
    writeFir(values.inputFir);
    values.outputFirs.forEach((values, output) => writeFir(values, output));
  });
  const equalizer = ensure(info, 'equalizer');
  template.eqBanks.forEach((bands, index) => {
    const bank = ensure(equalizer, 'preset', index + 1);
    bands.forEach((values, index) => {
      const band = ensure(bank, 'filter', index + 1);
      for (const [key, tag] of Object.entries({
        filterType: 'filterType',
        enabled: 'enabled',
        frequency: 'frequency',
        q: 'qparam',
        gain: 'gain',
      }))
        set(band, tag, values[key as keyof typeof values]);
    });
  });
  // Reparse emitted known fields to reject ambiguous indexed data retained in an
  // unknown subtree. Provenance is intentionally browser-only, never XML authority.
  const xml = new XMLSerializer().serializeToString(info);
  parseNativeCloneInfo(xml);
  return xml;
}

/** Dedicated Clone export can replace physical info after ordinary staged export. */
export function replaceNativeCloneInfo(xml: string, template: NativeCloneTemplate): string {
  const doc = xmlDocument(xml);
  const devices = doc.querySelectorAll('project > device');
  if (devices.length !== 1) throw new Error('Expected one Clone project device');
  const existing = children(devices[0], 'info');
  if (existing.length > 1) throw new Error('Duplicate Clone info snapshot');
  const replacement = doc.importNode(
    xmlDocument(writeNativeCloneInfo(template)).documentElement,
    true,
  );
  if (existing[0]) devices[0].replaceChild(replacement, existing[0]);
  else devices[0].appendChild(replacement);
  return new XMLSerializer().serializeToString(doc);
}
