import { useState, type Dispatch, type SetStateAction } from "react";
export function useSetting<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(`music-editor.${key}`) ?? "null");
      return stored !== null && typeof stored === typeof fallback ? stored as T : fallback;
    } catch { return fallback; }
  });
  const update: Dispatch<SetStateAction<T>> = next => setValue(current => {
    const resolved = typeof next === "function" ? (next as (old: T) => T)(current) : next;
    try { localStorage.setItem(`music-editor.${key}`, JSON.stringify(resolved)); } catch { /* Storage may be unavailable. */ }
    return resolved;
  });
  return [value, update];
}
