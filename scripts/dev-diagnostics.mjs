/** Redact configured values before retaining child-process startup diagnostics. */
export function startupDiagnostics(output, environment) {
  let safe = output;
  const values = Object.values(environment)
    .filter((value) => typeof value === "string" && value.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    safe = safe.split(value).join("[configured value]");
    safe = safe.split(encodeURIComponent(value)).join("[configured value]");
  }
  return safe.slice(-20_000);
}
