export const FEATURE_FLAGS = {
  newPipeline: 'NEW_PIPELINE',
  shadowWriteMode: 'SHADOW_WRITE_MODE',
} as const

export type FeatureFlag = keyof typeof FEATURE_FLAGS

export function getFlag(flag: FeatureFlag): boolean {
  // TypeScript callers are checked statically, but runtime inputs must still be
  // own keys: inherited names and unknown keys must never enable a flag.
  if (typeof flag !== 'string' || !Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, flag)) {
    return false
  }
  const envKey = FEATURE_FLAGS[flag]
  const value = process.env[envKey]
  return value === 'true' || value === '1'
}
