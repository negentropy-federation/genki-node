import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Digest } from "./digest.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const value = { z: 1, a: { d: 4, b: 2 }, list: [3, 1, 2] };

    expect(canonicalJson(value)).toBe('{"a":{"b":2,"d":4},"list":[3,1,2],"z":1}');
  });

  it("rejects values that are not JSON data", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("JSON-compatible");
    expect(() => canonicalJson(Number.NaN)).toThrow("finite");
  });
});

describe("sha256Digest", () => {
  it("is stable across object insertion order", () => {
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });

  it("changes when array order changes", () => {
    expect(sha256Digest([1, 2, 3])).not.toBe(sha256Digest([3, 2, 1]));
  });
});
