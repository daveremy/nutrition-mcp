import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeBarcode } from "../src/utils.js";

describe("normalizeBarcode", () => {
  it("zero-pads 12-digit UPC-A to 13-digit EAN-13", () => {
    const result = normalizeBarcode("123456789012");
    assert.equal(result, "0123456789012");
  });

  it("returns 13-digit EAN-13 as-is", () => {
    const result = normalizeBarcode("1234567890123");
    assert.equal(result, "1234567890123");
  });

  it("strips non-digit characters before normalizing", () => {
    assert.equal(normalizeBarcode("123-456 789012"), "0123456789012");
    assert.equal(normalizeBarcode("1234 5678 90123"), "1234567890123");
  });

  it("returns null for too short (11 digits)", () => {
    const result = normalizeBarcode("12345678901");
    assert.equal(result, null);
  });

  it("returns null for too long (14 digits)", () => {
    const result = normalizeBarcode("12345678901234");
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    const result = normalizeBarcode("");
    assert.equal(result, null);
  });
});
