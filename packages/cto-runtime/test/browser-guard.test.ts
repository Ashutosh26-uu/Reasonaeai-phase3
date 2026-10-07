import { describe, expect, it } from "vitest";
import {
  BrowserSecurityError,
  validateBrowserTargetUrl,
} from "../src/tools/browser-guard.js";

const METADATA_PATTERN = /metadata/i;
const CREDENTIALS_PATTERN = /credentials/i;
const RESTRICTED_PATTERN = /restricted/i;
const PROTOCOL_RELATIVE_PATTERN = /protocol-relative/i;

describe("validateBrowserTargetUrl - SSRF and Tenant Isolation", () => {
  it("allows loopback URLs for local preview proxy ports", () => {
    const url1 = validateBrowserTargetUrl("http://127.0.0.1:3000/");
    expect(url1.hostname).toBe("127.0.0.1");
    expect(url1.port).toBe("3000");

    const url2 = validateBrowserTargetUrl(
      "http://localhost:5173/preview?tab=console"
    );
    expect(url2.hostname).toBe("localhost");
    expect(url2.port).toBe("5173");

    const url3 = validateBrowserTargetUrl("http://[::1]:8080/dashboard");
    expect(url3.hostname).toBe("[::1]");
  });

  it("resolves relative paths against previewBaseUrl with previewId scoping", () => {
    const resolved = validateBrowserTargetUrl("/dashboard/settings", {
      previewBaseUrl: "http://127.0.0.1:4000",
    });
    expect(resolved.toString()).toBe(
      "http://127.0.0.1:4000/dashboard/settings"
    );

    const scoped = validateBrowserTargetUrl("/about", {
      previewBaseUrl: "http://127.0.0.1:4000",
      previewId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(scoped.pathname).toBe(
      "/v1/previews/123e4567-e89b-12d3-a456-426614174000/about"
    );
  });

  it("strictly rejects protocol-relative URLs and origin-escaping relative paths", () => {
    expect(() =>
      validateBrowserTargetUrl("//evil.com", {
        previewBaseUrl: "http://127.0.0.1:3000",
      })
    ).toThrow(PROTOCOL_RELATIVE_PATTERN);

    expect(() =>
      validateBrowserTargetUrl("/\\evil.com", {
        previewBaseUrl: "http://127.0.0.1:3000",
      })
    ).toThrow(PROTOCOL_RELATIVE_PATTERN);

    expect(() =>
      validateBrowserTargetUrl("\\\\evil.com", {
        previewBaseUrl: "http://127.0.0.1:3000",
      })
    ).toThrow(PROTOCOL_RELATIVE_PATTERN);
  });

  it("strictly rejects embedded credentials in URLs", () => {
    expect(() =>
      validateBrowserTargetUrl("http://admin:secret@127.0.0.1:3000/")
    ).toThrow(CREDENTIALS_PATTERN);
    expect(() =>
      validateBrowserTargetUrl("http://token@localhost:5173/")
    ).toThrow(CREDENTIALS_PATTERN);
  });

  it("strictly rejects forbidden infrastructure service ports", () => {
    // Redis
    expect(() => validateBrowserTargetUrl("http://127.0.0.1:6379/")).toThrow(
      RESTRICTED_PATTERN
    );
    // PostgreSQL
    expect(() => validateBrowserTargetUrl("http://127.0.0.1:5432/")).toThrow(
      RESTRICTED_PATTERN
    );
    // SSH
    expect(() => validateBrowserTargetUrl("http://127.0.0.1:22/")).toThrow(
      RESTRICTED_PATTERN
    );
    // Docker daemon
    expect(() => validateBrowserTargetUrl("http://127.0.0.1:2375/")).toThrow(
      RESTRICTED_PATTERN
    );
  });

  it("strictly rejects non-http protocols", () => {
    expect(() => validateBrowserTargetUrl("file:///etc/passwd")).toThrow(
      BrowserSecurityError
    );
    expect(() => validateBrowserTargetUrl("ftp://127.0.0.1:21")).toThrow(
      BrowserSecurityError
    );
    expect(() =>
      validateBrowserTargetUrl("javascript:alert(document.cookie)")
    ).toThrow(BrowserSecurityError);
    expect(() =>
      validateBrowserTargetUrl("data:text/html,<h1>PWNED</h1>")
    ).toThrow(BrowserSecurityError);
    expect(() => validateBrowserTargetUrl("gopher://localhost:70")).toThrow(
      BrowserSecurityError
    );
  });

  it("strictly rejects cloud metadata endpoints across representations", () => {
    // Standard AWS/GCP/Azure link-local
    expect(() =>
      validateBrowserTargetUrl("http://169.254.169.254/latest/meta-data/")
    ).toThrow(METADATA_PATTERN);

    // GCP DNS metadata
    expect(() =>
      validateBrowserTargetUrl(
        "http://metadata.google.internal/computeMetadata/v1/"
      )
    ).toThrow(METADATA_PATTERN);

    // DigitalOcean metadata
    expect(() =>
      validateBrowserTargetUrl("http://100.100.100.200/metadata/v1.json")
    ).toThrow(METADATA_PATTERN);

    // Decimal representation of 169.254.169.254 (2852039166)
    expect(() =>
      validateBrowserTargetUrl("http://2852039166/latest/meta-data/")
    ).toThrow(METADATA_PATTERN);

    // AWS IPv6 metadata
    expect(() =>
      validateBrowserTargetUrl("http://[fd00:ec2::254]/latest/meta-data/")
    ).toThrow(METADATA_PATTERN);

    // General 169.254.x.x link-local range
    expect(() =>
      validateBrowserTargetUrl("http://169.254.10.20/secret")
    ).toThrow(METADATA_PATTERN);

    // IPv6 link-local
    expect(() =>
      validateBrowserTargetUrl("http://[fe80::1]:3000/info")
    ).toThrow(METADATA_PATTERN);
  });

  it("blocks arbitrary private network scanning and DNS rebinding without allowedHosts", () => {
    expect(() =>
      validateBrowserTargetUrl("http://10.0.0.1:8080/admin")
    ).toThrow(BrowserSecurityError);
    expect(() =>
      validateBrowserTargetUrl("http://192.168.1.1:80/router")
    ).toThrow(BrowserSecurityError);
    expect(() =>
      validateBrowserTargetUrl("http://172.16.0.5:9000/internal")
    ).toThrow(BrowserSecurityError);

    // Non-routable 0.0.0.0
    expect(() => validateBrowserTargetUrl("http://0.0.0.0:3000/")).toThrow(
      BrowserSecurityError
    );

    // IPv6 ULA
    expect(() => validateBrowserTargetUrl("http://[fd00::1]:3000/")).toThrow(
      BrowserSecurityError
    );

    // DNS rebinding domains targeting internal IPs
    expect(() =>
      validateBrowserTargetUrl("http://10.0.0.1.nip.io:3000/")
    ).toThrow(BrowserSecurityError);
    expect(() =>
      validateBrowserTargetUrl("http://192.168.1.1.sslip.io:3000/")
    ).toThrow(BrowserSecurityError);
  });

  it("permits private network IP when explicitly in allowedHosts", () => {
    const url = validateBrowserTargetUrl("http://10.0.0.5:3000/preview", {
      allowedHosts: ["10.0.0.5", "preview.reasonate.internal"],
    });
    expect(url.hostname).toBe("10.0.0.5");
  });

  it("rejects empty or malformed URLs", () => {
    expect(() => validateBrowserTargetUrl("")).toThrow(BrowserSecurityError);
    expect(() => validateBrowserTargetUrl("   ")).toThrow(BrowserSecurityError);
    expect(() => validateBrowserTargetUrl("not-a-valid-url")).toThrow(
      BrowserSecurityError
    );
  });
});
