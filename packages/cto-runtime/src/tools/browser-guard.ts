/**
 * SSRF and Tenant-Isolation Security Guard for Browser Verification.
 *
 * Invariants:
 * 1. Only HTTP and HTTPS schemes are permitted (blocks file://, ftp://, javascript:, data:).
 * 2. URL embedded credentials (userinfo) are strictly prohibited.
 * 3. Protocol-relative URLs (//) and origin-escaping relative paths are rejected.
 * 4. Cloud metadata endpoints (AWS, GCP, Azure, DigitalOcean) are strictly blocked across
 *    all representations (IPv4, IPv6, mapped IPv6, hex, decimal, domain names, wildcard DNS).
 * 5. Forbidden infrastructure service ports (Postgres, Redis, SSH, Docker, etc.) are blocked.
 * 6. Loopback interfaces (localhost, 127.0.0.1, [::1]) are permitted for local preview proxy ports.
 * 7. Arbitrary internal private ranges (RFC 1918, IPv6 ULA, unspecified 0.0.0.0) outside
 *    the allowed preview hosts/ports are blocked by default.
 */

const BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP/Azure link-local metadata
  "169.254.169.250",
  "100.100.100.200", // DigitalOcean metadata
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data",
  "fd00:ec2::254", // AWS IPv6 metadata
]);

const DECIMAL_METADATA_IP = 2_852_039_166; // 169.254.169.254 in decimal
const HEX_METADATA_IP = 0xa9_fe_a9_fe;

const LINK_LOCAL_REGEX = /^169\.254\.\d{1,3}\.\d{1,3}$/;
const PRIVATE_10_REGEX = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const PRIVATE_172_REGEX = /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;
const PRIVATE_192_REGEX = /^192\.168\.\d{1,3}\.\d{1,3}$/;

// Regex detecting wildcard DNS / DNS-rebinding services embedding private or link-local IPs
const REBINDING_METADATA_REGEX =
  /(?:^|[.-])169[.-]254[.-]\d{1,3}[.-]\d{1,3}(?:\.|\b)/;
const REBINDING_PRIVATE_10_REGEX =
  /(?:^|[.-])10[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(?:\.|\b)/;
const REBINDING_PRIVATE_172_REGEX =
  /(?:^|[.-])172[.-](?:1[6-9]|2\d|3[01])[.-]\d{1,3}[.-]\d{1,3}(?:\.|\b)/;
const REBINDING_PRIVATE_192_REGEX =
  /(?:^|[.-])192[.-]168[.-]\d{1,3}[.-]\d{1,3}(?:\.|\b)/;

/**
 * Standard forbidden infrastructure and internal daemon ports.
 * Preview verification must never probe these services.
 */
const FORBIDDEN_PORTS = new Set([
  21, // FTP
  22, // SSH
  23, // Telnet
  25, // SMTP
  53, // DNS
  110, // POP3
  143, // IMAP
  445, // SMB
  2375, // Docker daemon HTTP
  2376, // Docker daemon TLS
  3306, // MySQL
  5432, // PostgreSQL
  5433,
  6379, // Redis
  6380, // Redis SSL
  11_211, // Memcached
  27_017, // MongoDB
  27_018,
]);

export interface ValidateTargetUrlOptions {
  allowedHosts?: string[] | undefined;
  previewBaseUrl?: string | undefined;
  previewId?: string | undefined;
}

export class BrowserSecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserSecurityError";
  }
}

/**
 * Checks whether an IP or hostname is a cloud metadata address.
 */
function isMetadataAddress(host: string): boolean {
  const cleanHost = host
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTS.has(cleanHost)) {
    return true;
  }

  // IPv4 mapped IPv6 (e.g. ::ffff:169.254.169.254)
  if (cleanHost.includes("169.254.169.254")) {
    return true;
  }

  // AWS IPv6 metadata prefix
  if (cleanHost.startsWith("fd00:ec2:")) {
    return true;
  }

  // IPv6 link-local range (fe80::/10)
  if (cleanHost.startsWith("fe80:") || cleanHost === "fe80::") {
    return true;
  }

  // Check for decimal / octal / hex encoded metadata IP
  const numericIp = Number(cleanHost);
  if (
    !Number.isNaN(numericIp) &&
    (numericIp === DECIMAL_METADATA_IP || numericIp === HEX_METADATA_IP)
  ) {
    return true;
  }

  // 169.254.0.0/16 link-local range
  if (LINK_LOCAL_REGEX.test(cleanHost)) {
    return true;
  }

  // Wildcard DNS / DNS rebinding embedding 169.254.x.x
  if (REBINDING_METADATA_REGEX.test(cleanHost)) {
    return true;
  }

  return false;
}

/**
 * Checks if a hostname refers to loopback.
 */
function isLoopbackAddress(host: string): boolean {
  const cleanHost = host
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, "");
  return (
    cleanHost === "localhost" ||
    cleanHost === "127.0.0.1" ||
    cleanHost === "::1" ||
    cleanHost.startsWith("127.") ||
    cleanHost === "::ffff:127.0.0.1" ||
    cleanHost.startsWith("::ffff:127.")
  );
}

/**
 * Checks if a host is an RFC 1918 private network address, IPv6 ULA, or non-routable address.
 */
function isPrivateNetworkAddress(host: string): boolean {
  const cleanHost = host
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, "");

  // Non-routable / unspecified addresses
  if (
    cleanHost === "0.0.0.0" ||
    cleanHost === "0" ||
    cleanHost === "::" ||
    cleanHost === "::0"
  ) {
    return true;
  }

  // Handle IPv4-mapped IPv6 (::ffff:10.x.x.x)
  if (cleanHost.startsWith("::ffff:")) {
    const ipv4Part = cleanHost.slice(7);
    return isPrivateNetworkAddress(ipv4Part);
  }

  // 10.0.0.0/8
  if (PRIVATE_10_REGEX.test(cleanHost)) {
    return true;
  }
  // 172.16.0.0/12
  if (PRIVATE_172_REGEX.test(cleanHost)) {
    return true;
  }
  // 192.168.0.0/16
  if (PRIVATE_192_REGEX.test(cleanHost)) {
    return true;
  }

  // IPv6 Unique Local Address (ULA - fc00::/7, fd00::/8)
  if (cleanHost.startsWith("fc") || cleanHost.startsWith("fd")) {
    return true;
  }

  // Wildcard DNS rebinding patterns embedding private IP ranges
  if (
    REBINDING_PRIVATE_10_REGEX.test(cleanHost) ||
    REBINDING_PRIVATE_172_REGEX.test(cleanHost) ||
    REBINDING_PRIVATE_192_REGEX.test(cleanHost)
  ) {
    return true;
  }

  return false;
}

function resolvePort(parsed: URL): number {
  if (parsed.port) {
    return Number.parseInt(parsed.port, 10);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

function resolveRelativeTarget(
  trimmed: string,
  options: ValidateTargetUrlOptions
): URL {
  if (!options.previewBaseUrl) {
    throw new BrowserSecurityError(
      `Relative URL "${trimmed}" cannot be resolved without previewBaseUrl.`
    );
  }

  let relativePath = trimmed;
  if (
    options.previewId &&
    !relativePath.startsWith(`/v1/previews/${options.previewId}`)
  ) {
    const prefix = `/v1/previews/${options.previewId}`;
    const suffix = relativePath.startsWith("/")
      ? relativePath
      : `/${relativePath}`;
    relativePath = `${prefix}${suffix}`;
  }

  const parsed = new URL(relativePath, options.previewBaseUrl);
  const baseParsed = new URL(options.previewBaseUrl);
  if (parsed.origin !== baseParsed.origin) {
    throw new BrowserSecurityError(
      `Resolved URL origin "${parsed.origin}" does not match previewBaseUrl origin "${baseParsed.origin}".`
    );
  }
  return parsed;
}

function parseAndVerifyUrl(
  inputUrl: string,
  options: ValidateTargetUrlOptions
): URL {
  if (
    !inputUrl ||
    typeof inputUrl !== "string" ||
    inputUrl.trim().length === 0
  ) {
    throw new BrowserSecurityError("Target URL cannot be empty.");
  }

  const trimmed = inputUrl.trim();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    trimmed.startsWith("\\\\")
  ) {
    throw new BrowserSecurityError(
      "Protocol-relative URLs are forbidden for browser verification."
    );
  }

  try {
    if (trimmed.startsWith("/")) {
      return resolveRelativeTarget(trimmed, options);
    }
    return new URL(trimmed);
  } catch (error) {
    if (error instanceof BrowserSecurityError) {
      throw error;
    }
    throw new BrowserSecurityError(
      `Invalid URL format: "${trimmed.slice(0, 100)}". Must be a valid absolute HTTP/HTTPS URL or relative path.`,
      { cause: error }
    );
  }
}

function verifyHostPermissions(
  hostname: string,
  host: string,
  allowedHosts?: string[]
): void {
  if (!allowedHosts || allowedHosts.length === 0) {
    return;
  }
  const isExplicitlyAllowed = allowedHosts.some(
    (allowed) =>
      allowed.toLowerCase() === hostname.toLowerCase() ||
      allowed.toLowerCase() === host.toLowerCase()
  );
  if (!(isExplicitlyAllowed || isLoopbackAddress(hostname))) {
    throw new BrowserSecurityError(
      `Navigation to host "${hostname}" is blocked: not in allowed preview hosts.`
    );
  }
}

function verifyTenantIsolation(
  hostname: string,
  allowedHosts?: string[]
): void {
  if (!isPrivateNetworkAddress(hostname)) {
    return;
  }
  const inAllowed = allowedHosts?.some(
    (h) => h.toLowerCase() === hostname.toLowerCase()
  );
  if (!inAllowed) {
    throw new BrowserSecurityError(
      `Navigation to private IP "${hostname}" is blocked by tenant isolation.`
    );
  }
}

/**
 * Validates and normalizes target URL for browser verification.
 * Resolves relative URLs if a previewBaseUrl is provided.
 */
export function validateBrowserTargetUrl(
  inputUrl: string,
  options: ValidateTargetUrlOptions = {}
): URL {
  const parsed = parseAndVerifyUrl(inputUrl, options);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserSecurityError(
      `Protocol "${parsed.protocol}" is forbidden. Browser verification only supports http: and https:.`
    );
  }

  if (parsed.username || parsed.password) {
    throw new BrowserSecurityError(
      "URLs with embedded credentials (userinfo) are forbidden."
    );
  }

  const portNumber = resolvePort(parsed);
  if (FORBIDDEN_PORTS.has(portNumber)) {
    throw new BrowserSecurityError(
      `Port ${portNumber} is restricted for browser verification (forbidden infrastructure service port).`
    );
  }

  const { hostname } = parsed;
  if (isMetadataAddress(hostname)) {
    throw new BrowserSecurityError(
      `Access to cloud metadata address "${hostname}" is strictly blocked.`
    );
  }

  verifyHostPermissions(hostname, parsed.host, options.allowedHosts);
  verifyTenantIsolation(hostname, options.allowedHosts);

  return parsed;
}
