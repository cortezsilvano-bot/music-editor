import { expect, it } from "vitest";
import { parameterHash, recordProvenance, staleAnalyzers } from "./registry";
import { analyze } from "./pipeline";
const result = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
it("records identity, version, parameters, timestamp and confidence per analyzer", () => {
  expect(staleAnalyzers(result)).toEqual([]);
  expect(result.provenance?.tempo).toMatchObject({ id: "tempo", version: "1.0.0", status: "completed", confidence: result.tempo.confidence });
  expect(result.provenance?.loudness?.confidence).toBeNull();
});
it("canonicalizes parameter order and detects configuration changes", () => {
  expect(parameterHash({ a: 1, b: 2 })).toBe(parameterHash({ b: 2, a: 1 }));
  expect(parameterHash({ a: 1 })).not.toBe(parameterHash({ a: 2 }));
});
it("identifies a changed analyzer without marking unrelated ones stale", () => {
  const provenance = recordProvenance(result, 123);
  provenance.tempo!.version = "0.9.0";
  expect(staleAnalyzers({ provenance })).toEqual(["tempo"]);
  expect(provenance.key?.completedAt).toBe(123);
});
it("treats legacy records as missing provenance rather than inventing history", () => {
  expect(staleAnalyzers({})).toContain("tempo");
});
