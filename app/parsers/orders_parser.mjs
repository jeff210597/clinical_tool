const DEFAULT_ORDERS_URL = "http://10.125.254.53:90/Desktop/ipd_allorder.asp";

export async function fetchInpatientOrders({ feeno, ordersUrl = DEFAULT_ORDERS_URL, fetchImpl = fetch }) {
  if (!feeno) throw new Error("feeno is required");
  const url = new URL(ordersUrl);
  url.searchParams.set("feeno", feeno);

  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`orders request failed: ${response.status}`);

  const buffer = await response.arrayBuffer();
  const html = decodeBig5(buffer);
  const initial = parseInpatientOrders(html);
  const range = extractOrderDateRange(html);
  if (!range) return initial;

  const fullUrl = new URL("ipd_allorder1.asp", url);
  fullUrl.searchParams.set("feeno", feeno);
  const fullResponse = await fetchImpl(fullUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      fee_no: feeno,
      A_start_date: range.startDate,
      b_end_date: range.endDate,
    }),
  });
  if (!fullResponse.ok) throw new Error(`full orders request failed: ${fullResponse.status}`);

  const fullHtml = decodeBig5(await fullResponse.arrayBuffer());
  return {
    ...parseInpatientOrders(fullHtml),
    queryRange: range,
    allAdmissionOrders: true,
  };
}

export function parseInpatientOrders(html) {
  const profile = parseHeaderProfile(html);
  const rows = [];
  const trMatches = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)];

  for (const tr of trMatches) {
    const cells = [...tr[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanCell(match[1]));
    if (cells.length < 5) continue;
    if (/開始|結束|簽收|給藥|DC|出院/.test(cells.join(" "))) continue;

    const item = cells[4] || "";
    if (!item) continue;

    rows.push({
      start: normalizeDateCell(cells[0]),
      end: normalizeDateCell(cells[1]),
      dischargeOrder: cells[2] || "",
      dc: cells[3] || "",
      item,
      signer: cells[5] || "",
      signedAt: normalizeDateCell(cells[6] || ""),
      giver: cells[7] || "",
      givenAt: normalizeDateCell(cells[8] || ""),
      rawCells: cells,
    });
  }

  return {
    source: "NIS 住院醫囑",
    status: "ok",
    capturedAt: new Date().toISOString(),
    profile,
    orders: rows,
    queryRange: extractOrderDateRange(html),
    allAdmissionOrders: false,
  };
}

function extractOrderDateRange(html) {
  const startOptions = extractSelectOptions(html, "A_start_date");
  const endOptions = extractSelectOptions(html, "b_end_date");
  if (!startOptions.length || !endOptions.length) return null;
  return {
    startDate: startOptions.sort()[0],
    endDate: endOptions.sort().at(-1),
    availableStartDates: startOptions,
    availableEndDates: endOptions,
  };
}

function extractSelectOptions(html, name) {
  const selectMatch = String(html || "").match(new RegExp(`<select\\b[^>]*name=["']${name}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (!selectMatch) return [];
  return [...selectMatch[1].matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
}

function decodeBig5(buffer) {
  try {
    return new TextDecoder("big5").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function parseHeaderProfile(html) {
  const bodyText = cleanCell(html.replace(/<table[\s\S]*$/i, ""));
  return {
    chartNo: matchField(bodyText, "病歷號"),
    name: matchField(bodyText, "姓名"),
    bedNo: matchField(bodyText, "床號"),
    age: matchField(bodyText, "年齡"),
    sex: matchField(bodyText, "性別"),
  };
}

function matchField(text, label) {
  const pattern = new RegExp(`${label}[:：]?\\s*([^｜|\n\r]+)`);
  return cleanText(text.match(pattern)?.[1] || "");
}

function normalizeDateCell(value) {
  return cleanText(String(value || "").replace(/\s+/g, " "));
}

function cleanCell(value) {
  return cleanText(
    String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<p\b[^>]*>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function cleanText(value) {
  return htmlDecode(value)
    .replace(/\u00a0/g, " ")
    .replace(/　/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
