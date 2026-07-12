// 凭据识别与日志兜底脱敏。写路径与审计共用同一套规则，避免「拒收了但又写进日志」。
const CREDENTIAL_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,            // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/,               // OpenAI / DeepSeek 风格
  /AKIA[0-9A-Z]{16}/,                    // AWS access key
  /ghp_[A-Za-z0-9]{20,}/,                // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/,        // GitHub fine-grained PAT
  /gho_[A-Za-z0-9]{20,}/,                // GitHub OAuth
  /xox[baprs]-[A-Za-z0-9-]{10,}/,        // Slack
  /AIza[0-9A-Za-z_-]{30,}/,              // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM 私钥
];

const COLLAPSIBLE = /[\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]+/gu;

export function containsCredential(value) {
  const raw = String(value ?? '');
  const collapsed = raw.replace(COLLAPSIBLE, '');
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(raw) || pattern.test(collapsed));
}

// 审计是最后一道防线：任意层级的字符串只要疑似含凭据，整段替换，不尝试保留局部上下文。
export function redactCredentials(value) {
  if (typeof value === 'string') {
    return containsCredential(value) ? '[REDACTED: suspected credential]' : value;
  }
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredentials(item)]));
  }
  return value;
}
