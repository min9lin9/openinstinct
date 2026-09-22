export interface AgentEmailIdentity {
  readonly address: string;
  readonly sendOrigin: string;
  readonly sendPath: string;
  readonly secretRef: string;
  readonly inboxUrl: string;
}

export const AGENT_EMAIL_SEND_ACTION = "send_agent_email";
/** Bumped whenever the authorized plan shape changes. */
export const AGENT_EMAIL_CAPABILITY_VERSION = 3;

const MAX_ADDRESS_LENGTH = 320;
const MAX_SECRET_REFERENCE_LENGTH = 512;
const MAX_URL_LENGTH = 8_192;

export function configuredAgentEmail(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentEmailIdentity | undefined {
  const rawAddress = env.OI_AGENT_EMAIL_ADDRESS;
  if (rawAddress === undefined) return undefined;

  const address = normalizeEmailAddress(rawAddress, "OI_AGENT_EMAIL_ADDRESS");
  const sendOrigin = exactOrigin(env.OI_AGENT_EMAIL_SEND_ORIGIN, "OI_AGENT_EMAIL_SEND_ORIGIN");
  const sendPath = exactPath(env.OI_AGENT_EMAIL_SEND_PATH, "OI_AGENT_EMAIL_SEND_PATH");
  const secretRef = secretReference(env.OI_AGENT_EMAIL_SECRET_REF);
  const inboxUrl = inboxUrlValue(env.OI_AGENT_EMAIL_INBOX_URL);

  return { address, sendOrigin, sendPath, secretRef, inboxUrl };
}

function normalizeEmailAddress(value: string, label: string): string {
  if (
    value.length === 0
    || value.length > MAX_ADDRESS_LENGTH
    || value !== value.trim()
    || /\s/.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a valid email address`);
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) {
    throw new Error(`${label} must contain exactly one @ with a local part and domain`);
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || domain.length > 255
    || domain.startsWith(".")
    || domain.endsWith(".")
    || domain.includes("..")
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(domain)
  ) {
    throw new Error(`${label} must be a valid email address`);
  }
  return `${local}@${domain.toLowerCase()}`;
}

function exactOrigin(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value !== value.trim() || value.length > MAX_URL_LENGTH) {
    throw new Error(`${label} must be an exact HTTP(S) origin`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an exact HTTP(S) origin`, { cause: error });
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
    throw new Error(`${label} must be an exact HTTP(S) origin`);
  }
  return url.origin;
}

function exactPath(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value.length > 8_192 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  let url: URL;
  try {
    url = new URL(value, "https://agent-email.invalid");
  } catch (error) {
    throw new Error(`${label} must be an exact absolute path`, { cause: error });
  }
  if (url.pathname !== value || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return value;
}

function secretReference(value: string | undefined): string {
  const label = "OI_AGENT_EMAIL_SECRET_REF";
  if (
    value === undefined
    || value.length === 0
    || value.length > MAX_SECRET_REFERENCE_LENGTH
    || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(value)
    || value.includes("/../")
    || value.endsWith("/..")
  ) {
    throw new Error(`${label} must be an opaque secret:// reference`);
  }
  return value;
}

function inboxUrlValue(value: string | undefined): string {
  const label = "OI_AGENT_EMAIL_INBOX_URL";
  if (value === undefined || value.length === 0 || value.length > MAX_URL_LENGTH || value !== value.trim()) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`, { cause: error });
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || url.hostname.length === 0
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  return url.href;
}
