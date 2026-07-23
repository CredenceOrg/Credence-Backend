export const FEATURE_FLAGS = {
  newPipeline: 'NEW_PIPELINE',
} as const

export type FeatureFlag = keyof typeof FEATURE_FLAGS

export function getFlag(flag: FeatureFlag): boolean {
  const envKey = FEATURE_FLAGS[flag]
  const value = process.env[envKey]
  return value === 'true' || value === '1'
}
