/** Redact configured values before retaining child-process startup diagnostics. */
const SENSITIVE_SETTING =
  /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

function decodedCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function startupDiagnostics(output, environment) {
  let safe = output;
  const values = new Set();
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || !value) {
      continue;
    }
    if (value.length >= 8 || SENSITIVE_SETTING.test(key)) {
      values.add(value);
    }
    if (URL.canParse(value)) {
      const url = new URL(value);
      for (const credential of [url.username, url.password]) {
        if (credential) {
          values.add(credential);
          values.add(decodedCredential(credential));
        }
      }
    }
  }
  for (const value of [...values].sort(
    (left, right) => right.length - left.length
  )) {
    safe = safe.split(value).join("[configured value]");
    safe = safe.split(encodeURIComponent(value)).join("[configured value]");
  }
  return safe.slice(-20_000);
}
