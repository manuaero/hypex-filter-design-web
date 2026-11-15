import { packet, presetBase, addr, hex } from './codec';
import { STATUS_FLAGS } from './status-flags';
import type { Transport } from './transport';
/** Protocol test double. Never used as a real connected-device substitute. */
export class SimulatedPanel implements Transport {
  memory = new Uint8Array(0x30000).fill(255);
  eeprom = new Uint8Array(1024);
  status = packet(5, 6, 1, 0xa8, 0xfd, 0, 128);
  name = 'Simulator';
  closed = false;
  configuration = packet(6, 22, 5, 1);
  deviceConfiguration = packet(0x66);
  /** Full signed-Q8 matrix, including latent values outside the ordinary editor. */
  mixerConfiguration = packet(0x67);
  mixerWrites = 0;
  powerMode = 2;
  noiseRequested = false;
  noiseRequests = 0;
  eqReloads = 0;
  displayUpdates = 0;
  oemMaskUpdates = 0;
  passwordWrites = 0;
  passwordVerifications = 0;
  emailWrites = 0;
  recoveryChallengeInstalls = 0;
  recoveryCodeSubmissions = 0;
  recoveryChallengeWord?: number;
  /** Explicit fixture input, never a local support-code derivation. Models inspected v5.82 only. */
  receivedRecoveryCode?: number;
  requests: Uint8Array[] = [];
  failAtPage?: number;
  corruptReadback = false;
  writes = 0;
  maxConcurrent = 0;
  private active = 0;
  private pageAddress = 0;
  private page: number[] = [];
  private selector = 1;
  constructor(readonly serial = 'SIM-LEFT') {
    for (const p of [1, 2, 3]) this.memory.fill(0, presetBase(p), presetBase(p) + 4096);
    this.eeprom.set(new TextEncoder().encode(serial), 0x100);
    const v = new DataView(this.configuration.buffer);
    v.setUint16(15, 5, true);
    v.setUint16(17, 7, true);
    this.configuration[14] = 128;
    [4500, 1500, 1500, 1500].forEach((n, i) => v.setUint16(50 + i * 2, n, true));
    this.deviceConfiguration[10] = 5;
    this.deviceConfiguration[12] = 22;
  }
  async exchange(request: Uint8Array) {
    if (this.closed) throw new Error('Disconnected simulator');
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      await Promise.resolve();
      this.requests.push(request.slice());
      const c = request[0];
      if (c === 4 && request[1] === 2) {
        const subcommand = request[2];
        if (subcommand === 0) {
          let ended = false;
          for (let i = 0; i < 16; i++) {
            ended ||= request[3 + i] === 0;
            this.eeprom[0x20 + i] = ended ? 0 : request[3 + i];
          }
          this.passwordWrites++;
          this.status[51] =
            (this.status[51] & ~STATUS_FLAGS.passwordProtected) |
            (this.eeprom[0x20] ? STATUS_FLAGS.passwordProtected : 0);
          return packet(4, 1);
        }
        if (subcommand === 2) {
          let accepted = true;
          for (let i = 0; i < 16; i++) {
            const stored = this.eeprom[0x20 + i];
            if (stored !== request[3 + i]) {
              accepted = false;
              break;
            }
            if (stored === 0) break;
          }
          this.passwordVerifications++;
          this.status[51] =
            (this.status[51] & ~(STATUS_FLAGS.passwordProtected | STATUS_FLAGS.passwordMatched)) |
            (this.eeprom[0x20] ? STATUS_FLAGS.passwordProtected : 0) |
            (accepted ? STATUS_FLAGS.passwordMatched : 0);
          return packet(4, accepted ? 1 : 0);
        }
        if (subcommand === 5) {
          let ended = false;
          for (let i = 0; i < 56; i++) {
            ended ||= request[3 + i] === 0;
            this.eeprom[0x50 + i] = ended ? 0 : request[3 + i];
          }
          this.emailWrites++;
          return packet(4, 1);
        }
        if (subcommand === 3) {
          this.recoveryChallengeWord = request[3] | (request[4] << 8);
          this.recoveryChallengeInstalls++;
          return packet(4, 1);
        }
        if (subcommand === 4) {
          this.recoveryCodeSubmissions++;
          const accepted =
            this.receivedRecoveryCode !== undefined &&
            this.receivedRecoveryCode === (request[3] | (request[4] << 8));
          if (accepted) {
            this.eeprom[0x20] = 0;
            this.status[51] &= ~STATUS_FLAGS.passwordProtected;
            this.recoveryChallengeWord = undefined;
            this.receivedRecoveryCode = undefined;
          }
          return packet(4, accepted ? 1 : 0);
        }
        if (subcommand === 6) return packet(4, 3, ...this.eeprom.slice(0x50, 0x88));
        throw new Error('Unsupported simulated credential subcommand');
      }
      if (c === 6) return this.configuration.slice();
      if (c === 0x66) {
        if (request[1] === 1) {
          this.deviceConfiguration = request.slice();
          this.deviceConfiguration[1] = 0;
        }
        return this.deviceConfiguration.slice();
      }
      if (c === 0x67) {
        if (request[1] === 1) {
          this.mixerConfiguration.set(request.slice(2, 38), 2);
          this.eeprom.set(request.slice(2, 38), 0xd0);
          this.mixerWrites++;
          const reply = this.mixerConfiguration.slice();
          // Explicit model of the inspected5.82 response builder, not a claim
          // that physical firmware5.7 ACK/EEPROM behavior has been qualified.
          reply[1] = request[2];
          return reply;
        }
        if (request[1] === 0) return this.mixerConfiguration.slice();
        throw new Error('Unsupported simulated mixer selector');
      }
      if (c === 8) {
        if (request[1] === 0x1e) {
          if (![0, 1].includes(request[2])) return packet(8, 0);
          this.noiseRequested = request[2] === 1;
          this.noiseRequests++;
          return packet(8, 1);
        }
        if (request[1] === 0) this.powerMode = 0;
        if (request[1] === 1) this.powerMode = 2;
        const r = packet(8, request[1] === 128 ? 128 : 1);
        r[15] = this.powerMode;
        return r;
      }
      if (c === 3) {
        if (request[1] === 0)
          this.name = new TextDecoder('latin1').decode(request.slice(2)).replace(/\0.*$/s, '');
        return packet(3, 0, ...new TextEncoder().encode(this.name));
      }
      if (c === 5) {
        if (request[1] === 0) {
          const protection = this.status[51];
          const previousMask = this.status.slice(24, 26);
          if (request[23] & 1) {
            this.eeprom.set(request.slice(24, 26), 0xba);
            this.oemMaskUpdates++;
          }
          if (request[23] & 8) this.displayUpdates++;
          this.status = request.slice();
          this.status[1] = 6;
          this.status[51] = protection;
          if (!(request[23] & 1)) this.status.set(previousMask, 24);
          // Software one-shot TX triggers are not a status template.
          this.status[23] = 0;
        }
        return this.status.slice();
      }
      if (c === 0x65) {
        const n = request[1],
          a = request[2] + (request[3] << 8) + (request[4] << 16);
        const data = request[5] === 0 ? this.eeprom.slice(a, a + n) : this.memory.slice(a, a + n);
        const r = packet(c, n, ...data);
        if (this.corruptReadback && this.writes) r[2] ^= 1;
        return r;
      }
      if (c === 0x64) {
        const op = request[1],
          a = request[2] + (request[3] << 8) + (request[4] << 16);
        if (op === 4) {
          this.memory.fill(255, a, a + 4096);
          this.writes++;
        }
        if (op === 3) this.eqReloads++;
        if (op === 0) {
          this.pageAddress = a;
          this.selector = request[5];
          this.page = [];
          if (this.failAtPage === a) throw new Error('Injected page failure');
        }
        if (op === 1) this.page.push(...request.slice(3, 3 + request[2]));
        if (op === 2) {
          if (this.page.length !== (this.selector === 0 ? 32 : 256))
            throw new Error('Incorrect page size');
          (this.selector === 0 ? this.eeprom : this.memory).set(this.page, this.pageAddress);
        }
        return packet(c, 0);
      }
      throw new Error(`Unsupported simulator command ${c}`);
    } finally {
      this.active--;
    }
  }
  async close() {
    this.closed = true;
  }
}
