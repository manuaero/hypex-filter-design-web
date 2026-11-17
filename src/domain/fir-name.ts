/** Erased 32-byte EEPROM filename slots are not Latin-1 filenames.
 * Keep raw bytes in recovery images; normalize only their interpreted name.
 */
export function firDisplayName(name: string): string {
  return name === '\u00ff'.repeat(32) ? '' : name;
}

export function decodeFirName(bytes: Uint8Array): string {
  if (bytes.every((byte) => byte === 0xff)) return '';
  return firDisplayName(new TextDecoder('latin1').decode(bytes).replace(/\0.*$/s, ''));
}
