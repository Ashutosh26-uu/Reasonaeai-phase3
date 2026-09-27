import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "../src/redirect.js";

const fallback = "/";
const options = { fallback };

describe("safeRedirectPath", () => {
  it("returns a same-origin path exactly as received", () => {
    for (const target of [
      "/",
      "/dashboard",
      "/projects/42?tab=runs#logs",
      "/a%20b",
      "/a%2fb",
      "/org/1/project/2",
    ]) {
      expect(safeRedirectPath(target, options)).toBe(target);
    }
  });

  it("falls back for absent, empty, and relative targets", () => {
    expect(safeRedirectPath(undefined, options)).toBe(fallback);
    expect(safeRedirectPath(null, options)).toBe(fallback);
    expect(safeRedirectPath("", options)).toBe(fallback);
    expect(safeRedirectPath("dashboard", options)).toBe(fallback);
    expect(safeRedirectPath("?next=/x", options)).toBe(fallback);
    expect(safeRedirectPath("#logs", options)).toBe(fallback);
    expect(safeRedirectPath(".", options)).toBe(fallback);
  });

  it("falls back for a protocol-relative or backslash absolute", () => {
    expect(safeRedirectPath("//evil.example", options)).toBe(fallback);
    expect(safeRedirectPath("//evil.example/path", options)).toBe(fallback);
    expect(safeRedirectPath("/\\evil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/\\/evil.example", options)).toBe(fallback);
    expect(safeRedirectPath("\\\\evil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/path\\..\\evil", options)).toBe(fallback);
  });

  it("falls back for an absolute URL or bare scheme", () => {
    expect(safeRedirectPath("https://evil.example", options)).toBe(fallback);
    expect(safeRedirectPath("http://evil.example/x", options)).toBe(fallback);
    expect(safeRedirectPath("javascript:alert(1)", options)).toBe(fallback);
    expect(safeRedirectPath("mailto:someone@evil.example", options)).toBe(
      fallback
    );
  });

  it("falls back when the target carries a control character", () => {
    expect(safeRedirectPath("/path\r\nSet-Cookie: injected=1", options)).toBe(
      fallback
    );
    expect(
      safeRedirectPath("/path\nLocation: https://evil.example", options)
    ).toBe(fallback);
    expect(safeRedirectPath("/pa\tth", options)).toBe(fallback);
    expect(safeRedirectPath("/pa\u0000th", options)).toBe(fallback);
  });

  it("falls back when decoding reveals a protocol-relative absolute", () => {
    expect(safeRedirectPath("%2f%2fevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%2f%2fevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%2F%2Fevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%252f%252fevil.example", options)).toBe(fallback);
  });

  it("falls back when decoding reveals a backslash absolute", () => {
    expect(safeRedirectPath("%5c%5cevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%5c%5cevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%5Cevil.example", options)).toBe(fallback);
    expect(safeRedirectPath("/%255cevil.example", options)).toBe(fallback);
  });

  it("falls back for a percent-encoded control character", () => {
    expect(
      safeRedirectPath("/%0d%0aLocation:%20https://evil.example", options)
    ).toBe(fallback);
    expect(safeRedirectPath("/path%09tab", options)).toBe(fallback);
    expect(safeRedirectPath("/path%00", options)).toBe(fallback);
    expect(safeRedirectPath("/%zz%0d%0aInjected:%201", options)).toBe(fallback);
  });

  it("refuses a value encoded past the inspection depth", () => {
    expect(safeRedirectPath("/%2525252f%2525252fevil.example", options)).toBe(
      fallback
    );
  });
});
