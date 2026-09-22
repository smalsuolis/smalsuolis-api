// A felling permit states the area of the stand it covers, not how much of that
// stand comes down: a clear cut takes all of it, a shelterwood cut roughly half,
// a thinning or tending cut about a quarter. These shares turn the declared area
// into an estimate of the area actually cleared.
//
// Matched by PREFIX, never by substring — "Kiti specialieji miško kirtimai (Bt,
// D, Gl, Bl kirtimas neplynaisiais kirtimais)" contains "plynais" and is a
// quarter-intensity cut.
const INTENSITY_BY_PREFIX: Array<[prefix: string, share: number]> = [
  ['Plynas', 1],
  ['Miško lydimo', 1],
  ['Atvejinis', 0.5],
  ['Atvejinių', 0.5],
  ['Supaprastintas atvejinis', 0.5],
];

const DEFAULT_INTENSITY = 0.25;

export const lumberingIntensity = (tagName: string): number => {
  const name = (tagName || '').trim();
  const match = INTENSITY_BY_PREFIX.find(([prefix]) => name.startsWith(prefix));
  return match ? match[1] : DEFAULT_INTENSITY;
};
