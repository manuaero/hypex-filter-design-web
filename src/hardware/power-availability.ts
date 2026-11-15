/** No firmware currently has a physically qualified, recoverable USB OFF path.
 * The connected5.7 panel lost USB after OFF.5.82's decoded firmware establishes
 * command semantics only; it is not physical qualification or a recovery proof.
 * This policy has no caller override and deliberately does not gate ON recovery. */
export function dspPowerOffAvailability(firmware?: string): { available: false; reason: string } {
  return {
    available: false,
    reason:
      firmware === '5.7'
        ? 'DSP off is unavailable on firmware 5.7: it has caused USB loss, and recovery is not qualified.'
        : 'DSP off is unavailable: a recoverable USB power-off transition has not been qualified for this firmware.',
  };
}
