import { fitLandmarkGrid } from '../src/mapping/alignment.mjs';

export function commandForAddedAlignmentPair(pairs) {
  if (pairs.length < 3) return { command: { type: 'alignment-pairs', value: pairs }, warning: null };
  try {
    fitLandmarkGrid(pairs);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { command: { type: 'alignment-pairs', value: pairs }, warning: error.message };
  }
  return { command: { type: 'alignment-apply', value: pairs }, warning: null };
}
