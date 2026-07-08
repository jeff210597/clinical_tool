const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function onepageBase() {
  return String(process.env.ONEPAGE_BASE || DEFAULT_ONEPAGE_BASE).replace(/\/$/, "");
}

function appToken() {
  return String(process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN);
}

function onepageHeaders(extra = {}) {
  const base = onepageBase();
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": base,
    "referer": `${base}/mypage`,
    "x-app-token": appToken(),
    ...extra,
  };
}

function asJsonText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Onepage returned non-JSON response: HTTP ${response.status}`);
  }
}

function extractJwt(data) {
  const candidates = [
    data?.jwt_token,
    data?.token,
    data?.auth_token,
    data?.data?.jwt_token,
    data?.data?.token,
    data?.data?.auth_token,
  ];
  for (const value of candidates) {
    if (JWT_PATTERN.test(String(value || ""))) return String(value);
  }
  return "";
}

function displayNameFromLogin(data, username) {
  return String(
    data?.name ||
    data?.user_name ||
    data?.displayName ||
    data?.display_name ||
    data?.data?.name ||
    username
  ).trim();
}

async function validateToken(authToken, username) {
  const response = await fetch(`${onepageBase()}/api/ipd.list`, {
    method: "POST",
    headers: onepageHeaders({ "x-wfauth": authToken }),
    body: JSON.stringify({
      doc_id: String(username || "").trim(),
      combine_care_doc_id: String(username || "").trim(),
      current: true,
    }),
  });
  if (!response.ok) return `Token validation warning: ipd.list HTTP ${response.status}`;
  return "";
}

async function loginOnepageDirect({ username, password }) {
  const response = await fetch(`${onepageBase()}/api/auth.login`, {
    method: "POST",
    headers: onepageHeaders(),
    body: JSON.stringify({
      id: String(username || "").trim(),
      pw: String(password || ""),
      sys: "onepage",
    }),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Onepage login HTTP ${response.status}: ${asJsonText(data).slice(0, 240)}`);
  }

  const authToken = extractJwt(data);
  if (!data?.auth || !JWT_PATTERN.test(authToken)) {
    const message = data?.message || data?.msg || data?.error || asJsonText(data).slice(0, 240);
    throw new Error(`Onepage login rejected or no token returned: ${message}`);
  }

  const validationWarning = await validateToken(authToken, username).catch((error) => error.message);
  return {
    username: String(username || "").trim(),
    displayName: displayNameFromLogin(data, username),
    authToken,
    validationWarning,
  };
}

export async function loginOnepageViaBrowser({ username, password }) {
  return loginOnepageDirect({ username, password });
}
