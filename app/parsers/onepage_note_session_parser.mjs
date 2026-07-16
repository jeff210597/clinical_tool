const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";

export async function fetchOnepageNoteSession({
  feeno,
  authToken,
  onepageBase = DEFAULT_ONEPAGE_BASE,
  appToken = process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN,
  fetchImpl = fetch,
}) {
  const feeNo = String(feeno || "").trim();
  if (!feeNo) throw new Error("feeno is required for note.sess");
  if (!authToken) throw new Error("Onepage auth token is required for note.sess");

  const base = String(onepageBase).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/api/note.sess`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: base,
      referer: `${base}/mypage`,
      "x-app-token": appToken,
      "x-wfauth": authToken,
    },
    body: JSON.stringify({ fee_no: feeNo, feeno: feeNo, no: feeNo, legacy: true }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`note.sess HTTP ${response.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
  if (!text.trim()) return emptyNoteSession();
  return normalizeNoteSession(JSON.parse(text));
}

export function normalizeNoteSession(payload) {
  const session = selectSession(payload);
  const note = session.note || session.content || session;
  return {
    admission: normalizeSingleNote(session.admission || note.admission, "入院病摘"),
    progress: normalizeProgress(session.progress || note.progress),
    discharge: normalizeSingleNote(session.discharge || note.discharge, "出院病摘"),
  };
}

function selectSession(payload) {
  const root = payload?.data || payload || {};
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  if (root.fee_no || root.admission || root.progress || root.discharge) return root;
  // note.list_sess returns an object keyed by fee_no.  Keep this fallback so
  // a harmless API-shape change cannot turn existing notes into "no data".
  return Object.values(root).find((value) => value && typeof value === "object" && (value.fee_no || value.admission || value.progress || value.discharge)) || {};
}

function emptyNoteSession() {
  return { admission: null, progress: [], discharge: null };
}

function normalizeProgress(value) {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.records) ? value.records
      : value && typeof value === "object" ? Object.values(value) : [];
  return entries
    .map((entry) => normalizeSingleNote(entry, "Progress"))
    .filter(Boolean)
    .sort((a, b) => parseNoteTime(b.date) - parseNoteTime(a.date));
}

function normalizeSingleNote(value, fallbackTitle) {
  if (!value) return null;
  const row = typeof value === "object" ? value : { content: value };
  const content = noteContent(row.content ?? row.note ?? row.text ?? row);
  const id = firstText(row.id, row.no, row.note_no, row.key);
  // Onepage's note.sess is an index: actual prose is opened in OneRecord by
  // this id.  An indexed record is still evidence that the note exists and
  // must not be reported as missing merely because the index has no prose.
  if (!content && !id) return null;
  return {
    id,
    date: firstText(row.date, row.first_submit_time, row.updated_at, row.update_time, row.created_at, row.time),
    title: firstText(row.title, row.type, row.kind, row.note_type) || fallbackTitle,
    author: firstText(row.doc_name, row.author, row.writer, row.user_name),
    content,
    availability: content ? "content" : "indexed",
    referenceText: content ? "" : "Onepage 已建檔；原始內容由 OneRecord 文件檢視器提供。",
  };
}

function noteContent(value) {
  if (typeof value === "string") return cleanText(value);
  if (!value || typeof value !== "object") return "";
  for (const key of ["content", "note", "text", "summary", "SUM", "DC"]) {
    const nested = value[key];
    if (nested === value) continue;
    const text = noteContent(nested);
    if (text) return text;
  }
  const sections = ["S", "O", "A", "P", "diagnosis", "assessment", "plan"]
    .map((key) => {
      const text = noteContent(value[key]);
      return text ? `${key.toUpperCase()}：${text}` : "";
    })
    .filter(Boolean);
  return sections.join("\n");
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseNoteTime(value) {
  const time = new Date(String(value || "").replace(/\//g, "-")).getTime();
  return Number.isNaN(time) ? 0 : time;
}
