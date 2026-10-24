// Only explicitly allowlisted diagnostic fields may reach the UI. Never stringify upstream errors.
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
    const { status, businessCode, total, accepted, endpoint, disabled, toolLess, unavailable, invalid, duplicate, excluded } = current.details;
    const fields = [];
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields.push("HTTP " + status);
    if (Number.isSafeInteger(businessCode)) fields.push("business code " + businessCode);
    for (const [name, value] of Object.entries({ total, accepted, endpoint, disabled, toolLess, unavailable, invalid, duplicate, excluded })) {
      if (Number.isSafeInteger(value) && value >= 0) fields.push(name + "=" + value);
    }
    const hint = current.diagnosticCode === "http" && businessCode === 12403 ?
      " WorkBuddy could not parse the client version/User-Agent; reload the updated extension." : "";
    return "[" + current.diagnosticCode + "] " + REASONS[current.diagnosticCode] +
      (fields.length ? " (" + fields.join(", ") + ")" : "") + hint;
  }
  return "[unknown] Catalog refresh failed. No upstream error text was displayed to protect credentials.";
}
