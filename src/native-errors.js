// Local validation diagnostics stay concise; upstream failures retain their response text.
const REASONS = {
  "credentials": "Credentials are missing or bound to a different endpoint; use /login.",
  "account-domain": "The account domain is not supported by this provider.",
  "metadata": "Account metadata or token has an invalid format.",
  "endpoint": "An untrusted endpoint was rejected.",
  "cancelled": "The operation was cancelled.",
  "request-timeout": "The WorkBuddy request timed out.",
  "network": "Cannot reach WorkBuddy; check connection or proxy settings.",
  "http": "The server rejected the request.",
  "empty-response": "The server returned an empty response.",
  "response-size": "The response exceeded the size limit.",
  "invalid-json": "The server response was not valid JSON.",
  "response-read": "The response body could not be read.",
  "envelope": "The JSON response envelope was unexpected.",
  "catalog-shape": "The response did not contain a supported models array.",
  "catalog-empty": "The server returned an empty model list.",
  "catalog-cache": "Cached model metadata was rejected; refresh to rebuild the catalog.",
  "catalog-filtered": "No model passed the provider's compatibility/security filters.",
};
export class WorkbuddyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkbuddyError";
    this.diagnosticCode = code;
    this.details = details;
  }
}

export function describeFailure(error) {
  const seen = new Set();
  for (let current = error, depth = 0; current && depth < 6 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current);
    if (!(current instanceof WorkbuddyError) || !Object.hasOwn(REASONS, current.diagnosticCode)) continue;
    const { status, businessCode, total, selected, accepted, endpoint, disabled, toolLess, nonChat, unavailable, invalid, duplicate, excluded } = current.details;
    const fields = [];
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields.push("HTTP " + status);
    if (Number.isSafeInteger(businessCode)) fields.push("business code " + businessCode);
    for (const [name, value] of Object.entries({ total, selected, accepted, endpoint, disabled, toolLess, nonChat, unavailable, invalid, duplicate, excluded })) {
      if (Number.isSafeInteger(value) && value >= 0) fields.push(name + "=" + value);
    }
    const reason = ["http", "invalid-json"].includes(current.diagnosticCode) ? current.message : REASONS[current.diagnosticCode];
    return "[" + current.diagnosticCode + "] " + reason +
      (fields.length ? " (" + fields.join(", ") + ")" : "");
  }
  return error instanceof Error ? error.message : String(error ?? "Catalog refresh failed.");
}
