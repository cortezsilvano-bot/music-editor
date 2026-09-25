import { useSetting } from "./settings";

/**
 * Feature flags (localStorage via useSetting).
 *
 * Keys are stable product names. Defaults are ON so existing installs keep
 * Mix, Stems and Duplicates visible until the user turns a flag off.
 */
export const FEATURE_FLAG_KEYS = {
  mixMode: "featureMixMode",
  stems: "featureStems",
  duplicates: "featureDuplicates",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];

/** React hook: persisted boolean flag, default true. */
export function useFeatureFlag(key: FeatureFlagKey): [boolean, (next: boolean) => void] {
  const [value, setValue] = useSetting(key, true);
  return [value, setValue];
}
