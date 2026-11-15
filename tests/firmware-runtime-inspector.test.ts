import { expect, it, vi } from 'vitest';
import {
  inspectFirmwareRuntime,
  FirmwareRuntimeSerialMismatchError,
  type FirmwareRuntimeInspectionOptions,
} from '../src/hardware/firmware-runtime-inspector';
import { PanelSession } from '../src/hardware/session';

// Independent literal64-byte vectors. Core/bundle version bytes follow the
// actual06 builders and segment2 metadata; all identities are synthetic.
const fromHex = (value: string) =>
  Uint8Array.from(value.replace(/\s/g, '').match(/../g)!, (pair) => parseInt(pair, 16));
const configuration51 = () =>
  fromHex(`
  06 16 05 01 12 03 0f 0f 0f 20 20 20 03 05 a0 05
  00 07 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 94 11 dc 05 dc 05 dc 05 00 00 00 00 00 00`);
const configuration55 = () =>
  fromHex(`
  06 16 05 05 12 03 0f 0f 0f 20 20 20 03 05 a0 05
  00 52 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 94 11 dc 05 dc 05 dc 05 00 00 00 00 00 00`);
const hardware = () =>
  fromHex(`
  66 00 00 00 00 00 00 00 00 00 05 09 16 01 01 55
  00 0f 90 01 2c 2d df 02 2c 2d df 02 72 e2 66 05
  19 06 f8 00 19 06 f8 00 19 06 f8 00 b9 fc ff 00
  b9 fc ff 00 b9 fc ff 00 14 14 14 28 28 28 00 00`);
const textReply = (command: number, text: string, selector: number) => {
  const result = new Uint8Array(64);
  result.set([command, selector]);
  result.set(new TextEncoder().encode(text), 2);
  return result;
};
function fixture(core: '5.1' | '5.5' = '5.5') {
  const frames = [
      core === '5.1' ? configuration51() : configuration55(),
      hardware(),
      textReply(3, 'Synthetic DSP name', 8),
      textReply(0x65, 'H05U-SYNTHETIC-INSPECTOR', 32),
    ],
    requests: Uint8Array[] = [];
  let intercept:
    ((reply: Uint8Array, index: number) => Uint8Array | Promise<Uint8Array>) | undefined;
  const transport = {
    exchange: vi.fn(async (request: Uint8Array) => {
      const index = requests.length;
      requests.push(request.slice());
      const reply = frames[index % 4].slice();
      return intercept ? intercept(reply, index) : reply;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    frames,
    requests,
    transport,
    set intercept(value: typeof intercept) {
      intercept = value;
    },
  };
}
const literalRequests = [
  [6, 1],
  [0x66, 0],
  [3, 8],
  [0x65, 32, 0, 1, 0, 0],
];
function onlyReadRequests(requests: Uint8Array[]) {
  expect(requests).toHaveLength(8);
  for (const [index, request] of requests.entries()) {
    const expected = new Uint8Array(64);
    expected.set(literalRequests[index % 4]);
    expect(Array.from(request)).toEqual(Array.from(expected));
  }
}

it.each(['5.1', '5.5'] as const)(
  'reads exact%s profiles twice with only the four literal read requests and no device lifecycle actions',
  async (core) => {
    const f = fixture(core),
      report = await inspectFirmwareRuntime(f.transport, {
        expectedSerial: 'H05U-SYNTHETIC-INSPECTOR',
      });
    expect(report).toEqual({
      identity: {
        serial: 'H05U-SYNTHETIC-INSPECTOR',
        product: 22,
        core,
        firmware: core === '5.1' ? '5.7' : '5.82',
        name: 'Synthetic DSP name',
      },
      hardware: { amplifier: 5, moduleType: 9, presets: 3, channels: 3 },
      profileId: core === '5.1' ? 'fusion32-5.7-core5.1' : 'fusion32-5.82-core5.5',
      controlsQualified: core === '5.1',
      familyProof: 'not-established-by-runtime-reports',
      imageProof: 'not-established-by-runtime-reports',
      consistency: 'double-read-matched',
    });
    onlyReadRequests(f.requests);
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.identity)).toBe(true);
    expect(Object.isFrozen(report.hardware)).toBe(true);
    f.frames[0][1] = 18;
    expect(report.identity.product).toBe(22);
  },
);

it.each(['bootloader', 'unknown core', 'wrong bundle', 'wrong product', 'mixed known versions'])(
  'rejects%s immediately after06 and sends no other requests',
  async (reason) => {
    const f = fixture();
    if (reason === 'bootloader') f.frames[0][2] = 99;
    if (reason === 'unknown core') f.frames[0][3] = 6;
    if (reason === 'wrong bundle') f.frames[0][17] = 83;
    if (reason === 'wrong product') f.frames[0][1] = 18;
    if (reason === 'mixed known versions') f.frames[0][3] = 1;
    await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow('Unqualified');
    expect(f.requests.map((r) => Array.from(r.slice(0, 2)))).toEqual([[6, 1]]);
  },
);

it.each(['short06', 'wrong command06', 'short66', 'wrong command03', 'wrong serial count'])(
  'rejects malformed%s instead of accepting partial or uncorrelated replies',
  async (reason) => {
    const f = fixture();
    f.intercept = (reply, index) => {
      if (reason === 'short06' && index === 0) return reply.slice(0, 63);
      if (reason === 'wrong command06' && index === 0) reply[0] = 5;
      if (reason === 'short66' && index === 1) return reply.slice(0, 63);
      if (reason === 'wrong command03' && index === 2) reply[0] = 4;
      if (reason === 'wrong serial count' && index === 3) reply[1] = 31;
      return reply;
    };
    await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow('Malformed');
    expect(f.requests.length).toBeLessThanOrEqual(4);
  },
);

it.each(['channels', 'presets', 'amplifier', 'hardware product', 'missing third output'])(
  'refuses inconsistent%s hardware metadata before name/serial reads',
  async (field) => {
    const f = fixture();
    if (field === 'channels') f.frames[0][5] = 2;
    if (field === 'presets') f.frames[0][12] = 0;
    if (field === 'amplifier') f.frames[1][10] = 4;
    if (field === 'hardware product') f.frames[1][12] = 18;
    if (field === 'missing third output') f.frames[1][13] = 0;
    await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow(/three|qualified/);
    expect(f.requests.length).toBeLessThanOrEqual(2);
  },
);

it.each(['configuration', 'FIR capability', 'module', 'limiter', 'name', 'serial'])(
  'returns no report when defined%s changes between snapshots',
  async (field) => {
    const f = fixture();
    f.intercept = (reply, index) => {
      if (field === 'configuration' && index === 4) reply[4] ^= 16;
      if (field === 'FIR capability' && index === 4) reply[57] ^= 1;
      if (field === 'module' && index === 5) reply[11] = 1;
      if (field === 'limiter' && index === 5) reply[20] ^= 1;
      if (field === 'name' && index === 6) reply[2] = 65;
      if (field === 'serial' && index === 7) reply[2] = 65;
      return reply;
    };
    await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow('changed during inspection');
    onlyReadRequests(f.requests);
  },
);

it('ignores only unowned reply padding and noncanonical selector bytes, never requiring a fabricated zero-filled reply', async () => {
  const f = fixture();
  f.intercept = (reply, index) => {
    if (index === 4) reply[25] = 201;
    if (index === 5) {
      reply[1] = 255;
      reply[4] = 203;
      reply[63] = 204;
    }
    if (index === 6) {
      reply[1] = 171;
      reply[44] = 205;
    }
    if (index === 7) reply[55] = 206;
    return reply;
  };
  expect((await inspectFirmwareRuntime(f.transport)).identity.core).toBe('5.5');
  onlyReadRequests(f.requests);
});

it.each(['serial control', 'serial DEL', 'empty serial', 'name control', 'junk after terminator'])(
  'does not trim or substitute malformed%s ASCII',
  async (field) => {
    const f = fixture();
    if (field === 'serial control') f.frames[3][3] = 9;
    if (field === 'serial DEL') f.frames[3][3] = 127;
    if (field === 'empty serial') f.frames[3].fill(0, 2);
    if (field === 'name control') f.frames[2][2] = 31;
    if (field === 'junk after terminator') {
      f.frames[3][3] = 0;
      f.frames[3][4] = 65;
    }
    await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow(/Malformed.*ASCII/);
  },
);

it('accepts an empty DSP filename but requires the exact full32-byte serial, without trimming spaces or case', async () => {
  const f = fixture();
  f.frames[2].fill(255, 2, 34);
  f.frames[3] = textReply(0x65, ' SERIAL WITH SPACES ', 32);
  const report = await inspectFirmwareRuntime(f.transport, {
    expectedSerial: ' SERIAL WITH SPACES ',
  });
  expect(report.identity.name).toBe('');
  expect(report.identity.serial).toBe(' SERIAL WITH SPACES ');
  const mismatch = fixture();
  await expect(
    inspectFirmwareRuntime(mismatch.transport, { expectedSerial: 'h05u-synthetic-inspector' }),
  ).rejects.toThrow('differs');
  expect(mismatch.requests).toHaveLength(4);
});

it('retains all32 printable serial/name bytes when the native field has no terminator', async () => {
  const f = fixture(),
    serial = 'S'.repeat(32),
    name = 'N'.repeat(32);
  f.frames[2] = textReply(3, name, 8);
  f.frames[3] = textReply(0x65, serial, 32);
  expect(
    (await inspectFirmwareRuntime(f.transport, { expectedSerial: serial })).identity,
  ).toMatchObject({ serial, name });
  onlyReadRequests(f.requests);
});

it('distinguishes a serial-mismatched candidate without disclosing expected or received identifiers', async () => {
  const f = fixture();
  const error = await inspectFirmwareRuntime(f.transport, {
    expectedSerial: 'H05U-OTHER-SYNTHETIC',
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(FirmwareRuntimeSerialMismatchError);
  expect(error).toMatchObject({
    name: 'FirmwareRuntimeSerialMismatchError',
    message: 'Firmware runtime serial differs from the captured amplifier',
  });
  expect(JSON.stringify(error)).not.toContain('H05U-');
  expect(String(error)).not.toContain('H05U-');
  expect(f.requests).toHaveLength(4);
});

it.each([
  ['channels', 5],
  ['presets', 12],
] as const)('binds the native%s count to its own distinct06 offset', async (field, offset) => {
  const f = fixture();
  f.frames[0][offset] = 2;
  await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow(`three advertised ${field}`);
  expect(f.requests).toHaveLength(1);
});

it('validates captured options before reading and never retargets if the caller mutates them during an await', async () => {
  const invalid = fixture();
  await expect(
    inspectFirmwareRuntime(invalid.transport, { expectedSerial: 'x'.repeat(33) }),
  ).rejects.toThrow('1–32');
  expect(invalid.requests).toHaveLength(0);
  const f = fixture(),
    options: { expectedSerial?: string } = { expectedSerial: 'H05U-SYNTHETIC-INSPECTOR' };
  f.intercept = (reply, index) => {
    if (index === 0) options.expectedSerial = 'OTHER';
    return reply;
  };
  expect((await inspectFirmwareRuntime(f.transport, options)).identity.serial).toBe(
    'H05U-SYNTHETIC-INSPECTOR',
  );
});

it.each(['before read', 'after first reply', 'after last reply'])(
  'honors abort%s without an extra command or any close/reset',
  async (when) => {
    const f = fixture(),
      abort = new AbortController();
    if (when === 'before read') abort.abort();
    f.intercept = (reply, index) => {
      if (
        (when === 'after first reply' && index === 0) ||
        (when === 'after last reply' && index === 7)
      )
        abort.abort();
      return reply;
    };
    await expect(inspectFirmwareRuntime(f.transport, { signal: abort.signal })).rejects.toThrow();
    expect(f.requests).toHaveLength(
      when === 'before read' ? 0 : when === 'after first reply' ? 1 : 8,
    );
    expect(f.transport.close).not.toHaveBeenCalled();
  },
);

it('checks the current role/session after every reply and immediately before returning the detached report', async () => {
  const f = fixture(),
    changed = new Error('replacement role');
  let current = true;
  f.intercept = (reply, index) => {
    if (index === 3) current = false;
    return reply;
  };
  await expect(
    inspectFirmwareRuntime(f.transport, {
      assertCurrent: () => {
        if (!current) throw changed;
      },
    }),
  ).rejects.toBe(changed);
  expect(f.requests).toHaveLength(4);
  const final = fixture();
  let checks = 0;
  const options: FirmwareRuntimeInspectionOptions = {
    assertCurrent: () => {
      if (++checks === 17) throw changed;
    },
  };
  await expect(inspectFirmwareRuntime(final.transport, options)).rejects.toBe(changed);
  onlyReadRequests(final.requests);
});

it('does not retry a lost read reply and leaves the ordinary core5.1 Session admission unchanged', async () => {
  const f = fixture();
  f.transport.exchange.mockRejectedValueOnce(new Error('lost read acknowledgement'));
  await expect(inspectFirmwareRuntime(f.transport)).rejects.toThrow('lost read');
  expect(f.transport.exchange).toHaveBeenCalledTimes(1);
  const ordinary = fixture();
  const session = new PanelSession(ordinary.transport, vi.fn());
  await expect(session.identify()).rejects.toThrow('requires the recovered');
  expect(ordinary.requests).toHaveLength(1);
});
