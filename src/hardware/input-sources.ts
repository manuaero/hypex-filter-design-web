/** Native 05 source enum. Labels identify values; they do not establish hardware availability. */
export const INPUT_SOURCES = Object.freeze([
  Object.freeze({ id: 0, label: 'Auto' }),
  Object.freeze({ id: 1, label: 'XLR' }),
  Object.freeze({ id: 2, label: 'RCA' }),
  Object.freeze({ id: 3, label: 'Sub' }),
  Object.freeze({ id: 4, label: 'S/PDIF' }),
  Object.freeze({ id: 5, label: 'AES' }),
  Object.freeze({ id: 6, label: 'Optical' }),
  Object.freeze({ id: 7, label: 'Future' }),
] as const);
export type InputSourceId = (typeof INPUT_SOURCES)[number]['id'];
export const MAX_INPUT_SOURCE = 7;
export const FUTURE_INPUT_NOTE =
  'Future is a native input selection; its firmware behavior has not been qualified.';
export function isInputSource(value: unknown): value is InputSourceId {
  return typeof value === 'number' && INPUT_SOURCES.some((source) => source.id === value);
}
/** Unknown persisted values remain visible and are never silently replaced by Auto. */
export function inputSourceLabel(value: number): string {
  return INPUT_SOURCES.find((source) => source.id === value)?.label ?? `Unknown input (${value})`;
}
// Native FA503 Clone choices differ from the common menu and retain its nonnumeric order.
export const CLONE_MASTER_INPUT_SOURCES = Object.freeze(
  [0, 1, 2, 5, 4, 6, 7].map((id) => INPUT_SOURCES[id]),
);
export const CLONE_SLAVE_INPUT_SOURCES = Object.freeze(
  [1, 2, 5, 4, 6, 7].map((id) => INPUT_SOURCES[id]),
);
