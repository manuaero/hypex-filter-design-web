import { type Preset, type Project, type Channel } from './model';
const shared = ['gain', 'invert', 'muted', 'delayUs', 'globalDelayUs', 'filters', 'fir'] as const;
export function rootChannel(p: Preset, index: number) {
  const seen = new Set<number>();
  let current = index;
  while (p.channels[current].linkedTo !== undefined) {
    if (seen.has(current)) throw new Error('Cyclic channel link');
    seen.add(current);
    current = p.channels[current].linkedTo!;
    if (!Number.isInteger(current) || current < 0 || current > 2)
      throw new Error('Invalid linked channel');
  }
  return current;
}
/** Validate links without normalizing legitimate independent native node state. */
export function assertProjectLinks(project: Project): void {
  for (const preset of project.presets)
    for (let index = 0; index < preset.channels.length; index++) rootChannel(preset, index);
}
function copyField(target: Channel, source: Channel, key: (typeof shared)[number]) {
  if (key === 'filters') {
    const ids = target.filters.map((f) => ({ id: f.id, sourceId: f.sourceId }));
    target.filters = structuredClone(source.filters).map((f, i) => ({ ...f, ...ids[i] }));
  } else if (key === 'fir') target.fir = structuredClone(source.fir);
  else Object.assign(target, { [key]: source[key] });
}
export function linkChannel(p: Preset, index: number, to: number | null) {
  if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('Invalid channel');
  if (to === null) {
    delete p.channels[index].linkedTo;
    return;
  }
  if (!Number.isInteger(to) || to < 0 || to > 2 || to === index)
    throw new Error('Link requires a different channel');
  const root = rootChannel(p, to);
  if (root === index) throw new Error('Cyclic channel link');
  p.channels[index].linkedTo = root;
  for (const key of shared) copyField(p.channels[index], p.channels[root], key);
  p.channels[index].coefficientCache =
    p.channels[root].coefficientCache === 'unresolved' ? 'unresolved' : 'base';
}
/** A linked group shares processing; driver measurements and labels remain local.
 * Slave processing controls are read-only; the master remains authoritative. */
export function synchronizeLinkedGroup(p: Preset, root: number) {
  if (!Number.isInteger(root) || root < 0 || root > 2 || rootChannel(p, root) !== root)
    throw new Error('Linked processing synchronization requires a master channel');
  const group = [0, 1, 2].filter((i) => rootChannel(p, i) === root);
  if (group.length < 2) return;
  for (const key of shared)
    for (const index of group)
      if (index !== root) {
        copyField(p.channels[index], p.channels[root], key);
        p.channels[index].coefficientCache =
          p.channels[root].coefficientCache === 'unresolved' ? 'unresolved' : 'base';
      }
}
/** Legacy whole-project synchronization remains available to existing callers. */
export function synchronizeLinks(project: Project, before?: Project) {
  for (const [n, p] of project.presets.entries()) {
    for (let root = 0; root < 3; root++) {
      if (rootChannel(p, root) !== root) continue;
      synchronizeLinkedGroup(p, root);
    }
  }
}
