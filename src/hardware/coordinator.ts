import type { PanelSession } from './session';
/** Reserve sessions in a process-stable order, including before identification.
 * Preflight waits for every participant before releasing any reservation. */
export async function coordinatedUpload<T>(
  jobs: {
    session: PanelSession;
    label?: string;
    prepare: () => Promise<T>;
    program: (plan: T) => Promise<void>;
  }[],
) {
  if (!jobs.length || new Set(jobs.map((j) => j.session)).size !== jobs.length)
    throw new Error('Each role requires a distinct amplifier');
  const ordered = [...jobs].sort((a, b) => a.session.lockOrder - b.session.lockOrder);
  const reserve = async (i: number): Promise<void> => {
    if (i < ordered.length) return ordered[i].session.exclusive(() => reserve(i + 1));
    const prepared = await Promise.allSettled(jobs.map(async (j) => j.prepare()));
    if (prepared.some((r) => r.status === 'rejected'))
      throw new Error(
        prepared
          .map((r, i) =>
            r.status === 'rejected'
              ? `${jobs[i].label ?? (i === 0 ? 'Left' : 'Right')}: ${String(r.reason)}`
              : '',
          )
          .filter(Boolean)
          .join(' · '),
      );
    const plans = prepared.map((r) => (r as PromiseFulfilledResult<T>).value);
    if (
      jobs.some((j) => !j.session.identity?.serial) ||
      new Set(jobs.map((j) => j.session.identity?.serial)).size !== jobs.length
    )
      throw new Error('The same physical amplifier cannot fill both roles');
    const mutes = await Promise.allSettled(
      jobs.map((j) => j.session.controlsInternal({ mute: true })),
    );
    if (mutes.some((r) => r.status === 'rejected'))
      throw new Error('Could not verify mute on every amplifier; nothing programmed');
    const results = await Promise.allSettled(jobs.map((j, n) => j.program(plans[n])));
    if (results.some((r) => r.status === 'rejected')) {
      await Promise.allSettled(jobs.map((j) => j.session.controlsInternal({ mute: true })));
      throw new Error(
        results
          .map(
            (r, i) =>
              `${jobs[i].label ?? (i === 0 ? 'Left' : 'Right')}: ${r.status === 'fulfilled' ? 'verified and muted' : String(r.reason)}`,
          )
          .join(' · '),
      );
    }
  };
  await reserve(0);
}
