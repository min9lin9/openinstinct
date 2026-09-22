export interface CallProviderConfig {
  readonly origin: string;
  readonly createPath: string;
  readonly statusPath: string;
  readonly callerId: string;
  readonly secretRef: string;
}



/** Reads the host-owned telephony provider binding without exposing credentials to the model. */
export function configuredCallProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CallProviderConfig | undefined {
  const originValue = env.OI_AGENT_CALL_ORIGIN;
  if (originValue === undefined) return undefined;

  const origin = exactOrigin(originValue, "OI_AGENT_CALL_ORIGIN");
  const createPath = exactPath(env.OI_AGENT_CALL_CREATE_PATH, "OI_AGENT_CALL_CREATE_PATH");
  const statusPath = exactPath(env.OI_AGENT_CALL_STATUS_PATH, "OI_AGENT_CALL_STATUS_PATH");
  const callerIdValue = requiredEnvironmentValue(env.OI_AGENT_CALL_CALLER_ID, "OI_AGENT_CALL_CALLER_ID");
  const secretRef = secretReference(
    env.OI_AGENT_CALL_SECRET_REF,
    "OI_AGENT_CALL_SECRET_REF",
  );

  let callerId: string;
  try {
    callerId = normalizeCallNumber(callerIdValue);
  } catch (error) {
    throw new Error(`OI_AGENT_CALL_CALLER_ID is invalid: ${errorMessage(error)}`);
  }

  return { origin, createPath, statusPath, callerId, secretRef };
}

/** Returns a canonical E.164 number and rejects numbers that cannot be called safely. */
export function normalizeCallNumber(value: string): string {
  if (typeof value !== "string") throw new Error("call number must be a string");
  const trimmed = value.trim();
  if (!trimmed.startsWith("+")) {
    throw new Error("call number must start with +");
  }
  const digits = trimmed.slice(1).replace(/[\s().-]/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new Error("call number must contain 8 to 15 digits after + and must not start with 0");
  }
  return `+${digits}`;
}

function exactOrigin(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be an exact http(s) origin`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an exact http(s) origin: ${errorMessage(error)}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || value !== url.origin
  ) {
    throw new Error(`${label} must be an exact scheme/host/port origin`);
  }
  return url.origin;
}

function exactPath(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !isExactPath(value)) {
    throw new Error(`${label} must be an exact absolute path without query or fragment`);
  }
  return value;
}

function isExactPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\0")) {
    return false;
  }
  try {
    const normalized = new URL(value, "https://agent-call.invalid");
    return normalized.pathname === value && normalized.search === "" && normalized.hash === "";
  } catch {
    return false;
  }
}

function requiredEnvironmentValue(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is required when OI_AGENT_CALL_ORIGIN is configured`);
  }
  return value;
}

function secretReference(value: string | undefined, label: string): string {
  const reference = requiredEnvironmentValue(value, label);
  if (
    reference.length > 512
    || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(reference)
    || reference.includes("/../")
    || reference.endsWith("/..")
  ) {
    throw new Error(`${label} must be an opaque secret:// reference`);
  }
  return reference;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
