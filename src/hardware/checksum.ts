import { hex } from './codec';
export const digest = async (b: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))));
