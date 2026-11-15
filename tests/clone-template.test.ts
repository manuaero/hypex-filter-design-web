// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  nativeCloneTemplateSchema,
  parseNativeCloneInfo,
  replaceNativeCloneInfo,
  writeNativeCloneInfo,
} from '../src/domain/clone-template';
import { exportHfd, importHfd, parseProject, projectSchema } from '../src/domain/files';
import { newProject } from '../src/domain/model';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';

const field = (name: string, value: string | number | boolean) => `<${name} value="${value}"/>`;
const fields = (values: Record<string, string | number | boolean>) =>
  Object.entries(values)
    .map(([name, value]) => field(name, value))
    .join('');

// Synthetic values, using the independently recovered c3db04/ab0280 native
// node names. Distinct bank/channel values catch incorrect offsets or merging.
function nativeInfo() {
  return `<info fixture="native-layout"><extension value="retain"><nested n="2"/></extension>${fields(
    {
      valid: true,
      hypexname: 'FA503',
      oemname: 'Synthetic',
      serialnumber: 'TEST-SOURCE-ONLY',
      configuredamplifier: 5,
      thirdchannelenabled: true,
      fanconnected: false,
      mixerenabled: true,
      configuredmoduletype: 9,
      detectedhardware: 22,
      tempsetpoint: 65,
      dsppeaksetpoint: 4096,
      productnr: 22,
      versionnr: 5,
      buildnr: 1,
      bootldrmode: false,
      dspfilename: 'Captured name',
      bundleversion: '',
      unitbehaviour: 2,
      diginpresent: true,
      testfirmware: false,
      subsetup: 0,
      nrofpresets: 3,
      nrofchannels: 3,
      btldrversion: 2,
      activeinput: 5,
      forcedinput: 4,
      actualvolume: -6.25,
      passwdprot: true,
      digitalchannelselect: 1,
      mfbenabled: false,
      startvolume: -200,
      stdbymode: 3,
      gainfactch12: 0.75,
      gainfactch3: 0.5,
      protmask: 65535,
      detlevon: 2,
      detlevoff: 3,
      oledbrightness: 246,
      syssetup: 226,
      selectedpreset: 2,
      muted: true,
      options: 25,
      advoptions: 1,
      pwrofftime: 15,
      routingch1: 0,
      routingch2: 1,
      routingch3: 2,
      routingch4: 3,
      routingch5: 4,
      routingch6: 5,
      bcdmajor: 5,
      bcdminor: 7,
      ctlbundleversion: '5.7',
    },
  )}${[1, 2, 3]
    .map(
      (p) =>
        `<mixer index="${p}">${fields({
          gch1l: p + 0.1,
          gch1r: p + 0.2,
          gch2l: p + 0.3,
          gch2r: p + 0.4,
          gch3l: p + 0.5,
          gch3r: p + 0.6,
        })}</mixer>`,
    )
    .join('')}<limiter>${[1, 2, 3]
    .map((ch) =>
      fields({
        [`thch${ch}`]: ch + 0.25,
        [`attackch${ch}`]: 0.9 + ch / 100,
        [`releasech${ch}`]: 0.99 + ch / 1000,
        [`impedancech${ch}`]: ch + 3,
        [`powerch${ch}`]: ch * 100,
      }),
    )
    .join('')}</limiter>${[1, 2, 3]
    .map(
      (p) =>
        `<preset index="${p}" extra="${p}">${fields({
          forceinput: p,
          volumeoffset: -p / 2,
          aoenable: p === 2,
          sourcelock: p === 1,
          volumelock: p === 3,
          eqenable: p === 2,
          apptype: p === 2 ? 1 : 0,
          inputfirloaded: p === 1,
          inputfirfilename: `Input-${p}.txt`,
          inputfirenable: p === 3,
        })}${[1, 2, 3]
          .map((ch) =>
            fields({
              [`firch${ch}loaded`]: ch === p,
              [`outputfirch${ch}filename`]: `P${p}C${ch}.txt`,
              [`firch${ch}enable`]: ch === 1,
            }),
          )
          .join('')}<preset-extension value="${p}"/></preset>`,
    )
    .join('')}<equalizer>${[1, 2, 3]
    .map(
      (p) =>
        `<preset index="${p}">${Array.from(
          { length: 9 },
          (_, i) =>
            `<filter index="${i + 1}">${fields({
              filterType: i % 3,
              enabled: i % 2 === 0,
              frequency: p * 1000 + i,
              qparam: 0.5 + i / 10,
              gain: -p - i / 10,
            })}</filter>`,
        ).join('')}</preset>`,
    )
    .join('')}</equalizer></info>`;
}
const fullProjectXml = () =>
  replaceNativeCloneInfo(
    exportHfd(newProject('Synthetic Clone')),
    parseNativeCloneInfo(nativeInfo())!,
  );

describe('independent native Clone metadata', () => {
  it('maps full module enum9, limiter/mixer rows, runtime settings, FIR metadata and physical EQ banks', () => {
    const template = parseNativeCloneInfo(nativeInfo())!;
    expect(template.provenance).toEqual({ kind: 'hfd-project', sourceSerial: 'TEST-SOURCE-ONLY' });
    expect(template.configuration).toMatchObject({
      valid: true,
      moduleType: 9,
      amplifier: 5,
      thirdChannelEnabled: true,
      fanConnected: false,
      mixerEnabled: true,
      temperatureSetpoint: 65,
      dspPeakSetpoint: 4096,
    });
    expect(template.configuration.mixer).toEqual([
      [1.1, 1.2, 1.3, 1.4, 1.5, 1.6],
      [2.1, 2.2, 2.3, 2.4, 2.5, 2.6],
      [3.1, 3.2, 3.3, 3.4, 3.5, 3.6],
    ]);
    expect(template.configuration.limiter[2]).toEqual({
      threshold: 3.25,
      attack: 0.93,
      release: 0.993,
      ohms: 6,
      watts: 300,
    });
    expect(template.device).toMatchObject({
      product: 22,
      version: 5,
      build: 1,
      dspFilename: 'Captured name',
      presetCount: 3,
      channelCount: 3,
    });
    expect(template.settings).toMatchObject({
      actualVolume: -6.25,
      passwordProtected: true,
      startupVolume: -200,
      oledBrightness: 246,
      systemSetup: 226,
      muted: true,
      protectionMask: 65535,
      routing: [0, 1, 2, 3, 4, 5],
    });
    expect(template.settings.presets[1]).toEqual({
      forceInput: 2,
      volumeOffset: -1,
      adcDigitalOut: true,
      sourceLock: false,
      volumeLock: false,
      eqEnabled: true,
      application: 1,
      inputFir: { loaded: false, filename: 'Input-2.txt', enabled: false },
      outputFirs: [
        { loaded: false, filename: 'P2C1.txt', enabled: true },
        { loaded: true, filename: 'P2C2.txt', enabled: false },
        { loaded: false, filename: 'P2C3.txt', enabled: false },
      ],
    });
    expect(template.eqBanks.map((bank) => bank[8])).toEqual(
      [1, 2, 3].map((p) => ({
        filterType: 2,
        enabled: true,
        frequency: p * 1000 + 8,
        q: 1.3,
        gain: -p - 0.8,
      })),
    );
    expect(template.settings).not.toHaveProperty('passwordMatched');
    expect(template.settings).not.toHaveProperty('channelMutes');
  });

  it('does not fabricate a snapshot for missing, empty or legacy browser equalizer-only info', () => {
    expect(parseNativeCloneInfo('<project><device/></project>')).toBeUndefined();
    expect(parseNativeCloneInfo('<info/>')).toBeUndefined();
    const xml = exportHfd(newProject());
    expect(xml).toContain('<equalizer>');
    expect(parseNativeCloneInfo(xml)).toBeUndefined();
    expect(importHfd(xml, 'Legacy').hfdCloneTemplate).toBeUndefined();
  });

  it('retains physical EQ/settings independently when ordinary project export uses staged EQ', () => {
    const project = importHfd(fullProjectXml(), 'Separate physical banks');
    const captured = structuredClone(project.hfdCloneTemplate!);
    expect(project.presets[0].eqEnabled).toBe(false);
    expect(captured.settings.presets[0].eqEnabled).toBe(false);
    project.presets[0].eqEnabled = true;
    project.presets[0].inputEq[0].gain = 12;
    expect(project.hfdCloneTemplate).toEqual(captured);
    const ordinary = parseNativeCloneInfo(exportHfd(project))!;
    expect(ordinary.eqBanks[0][0].gain).toBe(12);
    const explicit = parseNativeCloneInfo(replaceNativeCloneInfo(exportHfd(project), captured))!;
    expect(explicit.eqBanks[0][0].gain).toBe(-1);
    expect(explicit.settings.presets[0].eqEnabled).toBe(false);
    expect(project.hfdCloneTemplate).toEqual(captured);
  });

  it('preserves unknown info attributes/nodes at every known level while writing typed changes', () => {
    const template = parseNativeCloneInfo(nativeInfo())!;
    template.configuration.oemName = 'A & B <template>';
    template.eqBanks[2][8].gain = 4.5;
    const emitted = writeNativeCloneInfo(template);
    expect(emitted).toContain('fixture="native-layout"');
    expect(emitted).toContain('<nested n="2"');
    expect(emitted).toContain('<preset-extension value="3"');
    const reread = parseNativeCloneInfo(emitted)!;
    expect(reread.configuration.oemName).toBe('A & B <template>');
    expect(reread.eqBanks[2][8].gain).toBe(4.5);
    expect(reread.configuration.moduleType).toBe(9);
  });

  it('validates and retains metadata through JSON and exact native-folder browser sidecars', () => {
    const project = importHfd(fullProjectXml(), 'Snapshot persistence');
    project.hfdCloneTemplate!.eqBanks[0][0].gain = -4;
    expect(parseProject(JSON.stringify(project)).hfdCloneTemplate).toEqual(
      project.hfdCloneTemplate,
    );
    const files = projectFiles(project);
    expect(importProjectFolder(files).hfdCloneTemplate).toEqual(project.hfdCloneTemplate);
    // Native-only ordinary export follows staged EQ; sidecar restores independent physical capture.
    expect(
      importProjectFolder(files.filter((file) => file.path !== 'FusionProject.json'))
        .hfdCloneTemplate!.eqBanks[0][0].gain,
    ).toBe(-1);
    const invalid = structuredClone(project);
    (invalid.hfdCloneTemplate as unknown as { project: unknown }).project = newProject();
    expect(() => projectSchema.parse(invalid)).toThrow();
  });

  it.each([
    [
      'duplicate scalar',
      (xml: string) =>
        xml.replace('<valid value="true"/>', '<valid value="true"/><valid value="false"/>'),
    ],
    [
      'duplicate preset',
      (xml: string) => xml.replace('<preset index="2" extra="2">', '<preset index="1" extra="2">'),
    ],
    ['missing field', (xml: string) => xml.replace('<syssetup value="226"/>', '')],
    [
      'nonfinite',
      (xml: string) => xml.replace('<actualvolume value="-6.25"/>', '<actualvolume value="NaN"/>'),
    ],
    [
      'malformed bool',
      (xml: string) => xml.replace('<muted value="true"/>', '<muted value="128"/>'),
    ],
    [
      'out of primitive range',
      (xml: string) =>
        xml.replace('<configuredmoduletype value="9"/>', '<configuredmoduletype value="256"/>'),
    ],
    ['missing EQ band', (xml: string) => xml.replace('index="9"', 'index="8"')],
  ])('rejects %s rather than manufacturing native defaults', (_, change) => {
    expect(() => parseNativeCloneInfo(change(nativeInfo()))).toThrow();
  });

  it('retains unknown enum values for inspection without granting target compatibility', () => {
    const template = parseNativeCloneInfo(
      nativeInfo()
        .replace('<configuredmoduletype value="9"/>', '<configuredmoduletype value="42"/>')
        .replace('<filterType value="0"/>', '<filterType value="-1"/>'),
    )!;
    expect(template.configuration.moduleType).toBe(42);
    expect(template.eqBanks[0][0].filterType).toBe(-1);
    expect(nativeCloneTemplateSchema.parse(template)).toEqual(template);
    expect(parseNativeCloneInfo(writeNativeCloneInfo(template))!.configuration.moduleType).toBe(42);
  });

  it('rejects XML entities, duplicate info blocks and non-info unknown subtrees', () => {
    expect(() =>
      parseNativeCloneInfo(`<!DOCTYPE info [<!ENTITY secret "x">]>${nativeInfo()}`),
    ).toThrow(/DOCTYPE/);
    expect(() =>
      parseNativeCloneInfo(`<project><device>${nativeInfo()}${nativeInfo()}</device></project>`),
    ).toThrow(/one Clone info/);
    const template = parseNativeCloneInfo(nativeInfo())!;
    template.unknownInfoXml = '<project><device/></project>';
    expect(() => writeNativeCloneInfo(template)).toThrow(/one info/);
  });
});
