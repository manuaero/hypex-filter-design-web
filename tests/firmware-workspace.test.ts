import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFirmwareWorkspace,
  type FirmwareDeviceBinding,
  type FirmwareStage,
  type FirmwareWorkspaceSnapshot,
} from '../src/application/firmware-workspace';
import { createToolExecutor, type ToolAdapter, type DocumentState } from '../src/application/tools';
import { newProject, type Slot } from '../src/domain/model';
import { buildFirmwarePacketPlan, parseFirmwareBundle } from '../src/domain/firmware';

const header = ':10000080A80D0000CA080000465553494F4E3332B0';
const segment = ':01000081027C';
const address = ':020000040000FA';
const data = ':10068000464133320000000000000000000000007E';
const eof = ':00000001FF';
const text = [header, segment, address, data, eof].join('\r\n') + '\r\n';
const identity = (serial: string): FirmwareDeviceBinding => ({
  serial,
  core: '5.1',
  firmware: '5.7',
  product: 22,
});
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function record(type: number, values: number[], at = 0) {
  const bytes = [values.length, at >> 8, at & 255, type, ...values];
  bytes.push(-bytes.reduce((sum, value) => sum + value, 0) & 255);
  return (
    ':' +
    bytes
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

describe('shared firmware file workspace', () => {
  it('hashes the exact original file, captures ordinary device identity and returns immutable bounded metadata with programming unavailable', async () => {
    const current = identity('0303-EEPROM-IS-NOT-HID');
    const service = createFirmwareWorkspace({ binding: () => current });
    const idle = service.getSnapshot(),
      listener = vi.fn();
    expect(service.getSnapshot()).toBe(idle);
    const unsubscribe = service.subscribe(listener);
    const stage = await service.inspect('left', text, 'Uninterpreted v99.99 filename.hex');
    expect(stage).toMatchObject({
      name: 'Uninterpreted v99.99 filename.hex',
      sha256: hash(text),
      textBytes: Buffer.byteLength(text),
      family: 'FUSION32',
      headerWords: [3496, 2250],
      recordCount: 5,
      dataBytes: 16,
      segmentCount: 1,
      boundDevice: current,
      bindingChangedDuringInspection: false,
      programming: { available: false },
    });
    expect(stage.programming.reasons.map((reason) => reason.code)).toContain(
      'hid-product-serial-unavailable',
    );
    expect(stage.programming.reasons.map((reason) => reason.code)).toContain('writer-unavailable');
    expect(stage).not.toHaveProperty('version');
    expect(stage).not.toHaveProperty('records');
    expect(stage).not.toHaveProperty('content');
    expect(Object.isFrozen(stage.boundDevice)).toBe(true);
    expect(Object.isFrozen(stage.headerWords)).toBe(true);
    expect(Reflect.set(stage, 'family', 'FUSION01')).toBe(false);
    current.serial = 'Another device';
    expect(stage.boundDevice!.serial).toBe('0303-EEPROM-IS-NOT-HID');
    expect(service.getSnapshot().right).toEqual({ phase: 'empty' });
    expect(service.getSnapshot()).toBe(service.getSnapshot());
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    service.clear('left');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fences older asynchronous hashes and Clear without changing the newest stage', async () => {
    const first = deferred<string>(),
      second = deferred<string>(),
      third = deferred<string>();
    const digest = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const older = service.inspect('left', text, 'older.hex');
    const superseded = expect(older).rejects.toThrow('superseded');
    const newer = service.inspect('left', text, 'newer.hex');
    second.resolve('b'.repeat(64));
    const stage = await newer;
    const current = service.getSnapshot();
    first.resolve('a'.repeat(64));
    await superseded;
    expect(service.getSnapshot()).toBe(current);
    expect(service.getSnapshot().left.stage).toBe(stage);
    const clearing = service.inspect('left', text, 'cleared.hex');
    const cleared = expect(clearing).rejects.toThrow('superseded');
    service.clear('left');
    third.resolve('c'.repeat(64));
    await cleared;
    expect(service.getSnapshot().left).toEqual({ phase: 'empty' });
    expect(() => service.packetPreview('left', 0)).toThrow('Inspect');
  });

  it('captures a pre-read token and original device without retargeting when the binding changes', async () => {
    const bindings: Partial<Record<Slot, FirmwareDeviceBinding>> = {
      left: identity('ORIGINAL'),
      right: identity('RIGHT'),
    };
    const service = createFirmwareWorkspace({ binding: (slot) => bindings[slot] });
    const token = service.captureTarget('left');
    expect(service.getSnapshot().left.phase).toBe('empty');
    bindings.left = identity('REPLACEMENT');
    const staged = await service.inspect('left', text, 'captured-before-read.hex', token);
    expect(staged.boundDevice!.serial).toBe('ORIGINAL');
    expect(staged.bindingChangedDuringInspection).toBe(true);
    expect(staged.programming.reasons.map((reason) => reason.code)).toContain(
      'device-binding-changed',
    );
    expect(service.getSnapshot().right.phase).toBe('empty');
    await expect(service.inspect('left', text, 'replayed-token.hex', token)).rejects.toThrow(
      'target was cleared',
    );
  });

  it('rejects pre-read tokens invalidated by Clear/newer inspection and foreign or wrong-role token objects', async () => {
    const digest = vi.fn(async () => hash(text));
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const beforeClear = service.captureTarget('left');
    service.clear('left');
    await expect(
      service.inspect('left', text, 'read-after-clear.hex', beforeClear),
    ).rejects.toThrow('target was cleared');
    expect(digest).not.toHaveBeenCalled();
    const beforeNew = service.captureTarget('left');
    const stage = await service.inspect('left', text, 'newest.hex');
    await expect(service.inspect('left', text, 'old-read.hex', beforeNew)).rejects.toThrow(
      'target was cleared',
    );
    expect(service.getSnapshot().left.stage).toBe(stage);
    const foreign = createFirmwareWorkspace({ binding: () => undefined }).captureTarget('left');
    await expect(service.inspect('left', text, 'foreign.hex', foreign)).rejects.toThrow(
      'another role/workspace',
    );
    const right = service.captureTarget('right');
    await expect(service.inspect('left', text, 'wrong-role.hex', right)).rejects.toThrow(
      'another role/workspace',
    );
    await expect(service.inspect('left', text, 'JSON-token.hex', JSON.parse('{}'))).rejects.toThrow(
      'another role/workspace',
    );
  });

  it('does not leave an older inspection busy when a new chooser token supersedes it and is cancelled', async () => {
    const first = deferred<string>();
    const digest = vi
      .fn()
      .mockResolvedValueOnce(hash(text))
      .mockImplementationOnce(() => first.promise);
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const stage = await service.inspect('left', text, 'previous.hex');
    const pending = service.inspect('left', text, 'older-hash.hex');
    const rejected = expect(pending).rejects.toThrow('superseded');
    service.captureTarget('left');
    expect(service.getSnapshot().left).toEqual({ phase: 'ready', stage });
    first.resolve('a'.repeat(64));
    await rejected;
    expect(service.getSnapshot().left).toEqual({ phase: 'ready', stage });
  });

  it('keeps roles independent and retains a clearly identified previous stage when a new inspection fails', async () => {
    const service = createFirmwareWorkspace({ binding: (slot) => identity(slot) });
    const [left, right] = await Promise.all([
      service.inspect('left', text, 'left.hex'),
      service.inspect('right', text, 'right.hex'),
    ]);
    await expect(service.inspect('left', text.replace('7E', '7F'), 'broken.hex')).rejects.toThrow(
      'checksum',
    );
    expect(service.getSnapshot().left).toMatchObject({ phase: 'error', stage: left });
    expect(service.getSnapshot().left.error).toContain('broken.hex');
    expect(service.getSnapshot().left.error).toContain(
      'Previous staged file "left.hex" was retained',
    );
    expect(service.packetPreview('left', 0).sha256).toBe(left.sha256);
    service.clear('left');
    expect(service.getSnapshot().right).toEqual({ phase: 'ready', stage: right });
  });

  it('returns bounded exact packet pages from the shared native plan and never returns whole record/source arrays', async () => {
    const service = createFirmwareWorkspace({ binding: () => undefined });
    const source = [
      header,
      ...Array.from({ length: 1000 }, (_, i) => [segment, record(0, [i & 255], i)]).flat(),
      eof,
    ].join('\n');
    const stage = await service.inspect('right', source, 'many-segments.hex');
    expect(stage.segmentCount).toBe(1000);
    expect(stage.segmentsPreview).toHaveLength(20);
    expect(stage.programming.available).toBe(false);
    const page = service.packetPreview('right', 1, 2, 50);
    expect(page.packets).toHaveLength(50);
    expect(page).toMatchObject({
      slot: 'right',
      stageId: stage.id,
      sha256: hash(source),
      pass: 1,
      offset: 2,
      total: 1001,
      nextOffset: 52,
    });
    expect(page.packets.every((packet) => /^[a-f\d]{128}$/.test(packet.payloadHex))).toBe(true);
    expect(page.packets[0].payloadHex.startsWith('400001')).toBe(true);
    const expected = buildFirmwarePacketPlan(parseFirmwareBundle(source))
      .packets.filter((packet) => packet.pass === 1)
      .slice(2, 52);
    expect(page.packets.map((packet) => packet.payloadHex)).toEqual(
      expected.map((packet) => Buffer.from(packet.payload).toString('hex')),
    );
    expect(service.packetPreview('right', 0, 1001, 1)).toMatchObject({
      packets: [],
      nextOffset: null,
    });
    for (const args of [
      [0, -1, 1],
      [0, 0, 0],
      [0, 0, 51],
      [0, 1002, 1],
      [2, 0, 1],
    ])
      expect(() => service.packetPreview('right', args[0] as 0, args[1], args[2])).toThrow();
    expect(JSON.stringify(service.getSnapshot()).length).toBeLessThan(20000);
    expect(JSON.stringify(page).length).toBeLessThan(20000);
    expect(JSON.stringify(service.getSnapshot())).not.toContain(header);
  });

  it('rejects unpacketizable records before hashing and rejects failed/invalid hashes without replacing previous data', async () => {
    const digest = vi.fn(async () => hash(text));
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const tooWide = [
      header,
      segment,
      record(0, Array(32).fill(1)),
      record(0, Array(32).fill(2)),
      eof,
    ].join('\n');
    await expect(service.inspect('left', tooWide, 'unpacketizable.hex')).rejects.toThrow('61-byte');
    expect(digest).not.toHaveBeenCalled();
    const previous = await service.inspect('left', text, 'valid.hex');
    digest.mockResolvedValueOnce('not-sha256');
    await expect(service.inspect('left', text, 'bad-hash.hex')).rejects.toThrow('SHA-256');
    expect(service.getSnapshot().left.stage).toBe(previous);
    expect(service.packetPreview('left', 0).stageId).toBe(previous.id);
  });
});

describe('cached firmware inspection tools', () => {
  function setup() {
    const hardware = vi.fn(() => {
      throw new Error('Firmware staging must not call a device');
    });
    const state: DocumentState = {
      documents: { left: newProject('Left'), right: newProject('Right') },
      slot: 'right',
      preset: 2,
      channel: 1,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
    };
    const service = createFirmwareWorkspace({ binding: (slot) => identity(`trusted-${slot}`) });
    const noEdit = vi.fn(() => {
      throw new Error('Firmware staging must not edit projects');
    });
    const adapter: ToolAdapter = {
      state: () => state,
      edit: noEdit,
      choose: noEdit,
      undo: noEdit,
      redo: noEdit,
      connections: hardware,
      connect: async () => hardware(),
      disconnect: async () => hardware(),
      refresh: async () => hardware(),
      operate: async (_label, fn) => fn(),
      message: vi.fn(),
      progress: hardware,
      view: vi.fn(),
      firmware: service,
    };
    return { execute: createToolExecutor(adapter), service, hardware, noEdit, state };
  }
  type Reply = {
    ok: boolean;
    error?: string;
    firmware?: Partial<Record<Slot, { phase: string; stage?: FirmwareStage }>>;
    packetPage?: { packets: unknown[]; sha256: string; pass: number; nextOffset: number | null };
    results?: { slot: Slot; ok: boolean }[];
  };
  it('inspects/statuses/clears explicit independent roles offline through the existing device-read tool', async () => {
    const s = setup();
    const staged = (await s.execute('fusion_device_read', {
      target: 'both',
      firmware: { action: 'inspect', content: text, name: 'bundle.hex' },
    })) as Reply;
    expect(staged.ok).toBe(true);
    expect(staged.results).toEqual([
      { slot: 'left', ok: true },
      { slot: 'right', ok: true },
    ]);
    expect(staged.firmware!.left!.stage!.boundDevice!.serial).toBe('trusted-left');
    expect(staged.firmware!.right!.stage!.boundDevice!.serial).toBe('trusted-right');
    const status = (await s.execute('fusion_device_read', {
      target: 'left',
      firmware: { action: 'status' },
    })) as Reply;
    expect(Object.keys(status.firmware!)).toEqual(['left']);
    expect(status.firmware!.left!.stage!.sha256).toBe(hash(text));
    expect(status.firmware!.left!.stage!.programming.available).toBe(false);
    const page = (await s.execute('fusion_device_read', {
      target: 'right',
      firmware: { action: 'packets', pass: 1, offset: 0, limit: 2 },
    })) as Reply;
    expect(page.packetPage).toMatchObject({ pass: 1, nextOffset: 2, sha256: hash(text) });
    expect(page.packetPage!.packets).toHaveLength(2);
    expect(
      (
        (await s.execute('fusion_device_read', {
          target: 'left',
          firmware: { action: 'clear' },
        })) as Reply
      ).firmware!.left!.phase,
    ).toBe('empty');
    expect(s.service.getSnapshot().right.phase).toBe('ready');
    expect(s.hardware).not.toHaveBeenCalled();
    expect(s.noEdit).not.toHaveBeenCalled();
    expect(JSON.stringify(staged).length).toBeLessThan(65536);
    expect(JSON.stringify(staged)).not.toContain(header);
  });

  it('rejects spoofed binding/HID values, mixed actions, invalid packet pages and both-role packets before service/device effects', async () => {
    const s = setup(),
      before = s.service.getSnapshot();
    for (const firmware of [
      { action: 'inspect', content: text, name: 'file.hex', hidSerial: '0303-spoof' },
      { action: 'inspect', content: text, name: 'file.hex', binding: identity('spoof') },
      { action: 'inspect', content: text, name: 'file.hex', owner: 'site:spoof' },
      { action: 'inspect', content: text },
      { action: 'program' },
      { action: 'status', content: text },
      { action: 'packets', pass: 2 },
      { action: 'packets', pass: 0, limit: 51 },
      { action: 'packets', pass: 0, offset: -1 },
    ])
      expect(
        ((await s.execute('fusion_device_read', { target: 'left', firmware })) as Reply).ok,
      ).toBe(false);
    expect(
      (
        (await s.execute('fusion_device_read', {
          target: 'both',
          firmware: { action: 'packets', pass: 0 },
        })) as Reply
      ).ok,
    ).toBe(false);
    expect(s.service.getSnapshot()).toBe(before);
    expect(s.hardware).not.toHaveBeenCalled();
    expect(s.noEdit).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    await expect(
      s.execute(
        'fusion_device_read',
        { target: 'left', firmware: { action: 'inspect', content: text, name: 'aborted.hex' } },
        { owner: 'site:alice', scope: 'lease', signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(s.service.getSnapshot()).toBe(before);
  });

  it('reports independent bounded parse errors without connection fallback or clearing a valid opposite role', async () => {
    const s = setup();
    await s.service.inspect('right', text, 'right.hex');
    const right = s.service.getSnapshot().right;
    const failed = (await s.execute('fusion_device_read', {
      target: 'left',
      firmware: { action: 'inspect', content: 'invalid', name: 'invalid.hex' },
    })) as Reply;
    expect(failed.ok).toBe(false);
    expect(failed.results).toEqual([expect.objectContaining({ slot: 'left', ok: false })]);
    expect(s.service.getSnapshot().right).toBe(right);
    expect(s.service.getSnapshot().left.phase).toBe('error');
    expect(JSON.stringify(failed).length).toBeLessThan(16384);
    expect(s.hardware).not.toHaveBeenCalled();
    expect(s.noEdit).not.toHaveBeenCalled();
  });
});
