const DEFAULT_NIS_BASE = "http://10.125.254.46/NIS";

export async function fetchIntakeOutputFromTpr({
  feeno,
  startDate = "",
  endDate = todayText(),
  nisBase = DEFAULT_NIS_BASE,
  fetchImpl = fetch,
}) {
  const feeNo = String(feeno || "").trim();
  if (!feeNo) throw new Error("feeno is required");

  const range = await resolveTprRange({ feeNo, startDate, endDate, nisBase, fetchImpl });
  const url = `${nisBase.replace(/\/$/, "")}/HISVIEW/Partial_Tpr?${new URLSearchParams({
    feeno: feeNo,
    start: range.startDate,
    end: range.endDate,
  })}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`partial TPR request failed: ${response.status}`);

  return {
    source: "NIS TPR 輸入輸出",
    endpoint: "HISVIEW/Partial_Tpr",
    capturedAt: new Date().toISOString(),
    period: `${range.startDate} - ${range.endDate}`,
    ...parseIntakeOutputFromTpr(await response.text()),
  };
}

export function parseIntakeOutputFromTpr(html) {
  const grid = buildTableGrid(html);
  const allColumns = [];
  const input = new Map();
  const output = new Map();
  const totals = [];
  let currentGroup = "";
  let activeColumns = [];

  for (const row of grid) {
    const rowClass = row.find(Boolean)?.rowClass || "";
    const texts = row.map((cell) => cleanText(cell?.text || ""));
    if (texts[0]?.includes("日期")) {
      activeColumns = extractDateColumns(row);
      for (const column of activeColumns) {
        if (!allColumns.some((item) => item.date === column.date)) {
          allColumns.push({ key: `d${allColumns.length}`, date: column.date });
        }
      }
      continue;
    }

    if (rowClass.includes("Input") || texts[0]?.includes("輸入")) currentGroup = "input";
    if (rowClass.includes("Output") || texts[0]?.includes("輸出")) currentGroup = "output";

    if (rowClass.includes("InputOutputSum") || texts.join(" ").includes("輸入總量/輸出總量")) {
      totals.push(...extractTotalValues(row, activeColumns));
      continue;
    }

    if (rowClass.includes("Input") || rowClass.includes("Output")) {
      const item = firstMeaningfulItem(texts);
      if (!item || /輸入|輸出/.test(item)) continue;
      const record = {
        item,
        values: extractDailyValues(row, activeColumns),
      };
      if (!record.values.some((value) => value.value || value.detail)) continue;
      if (currentGroup === "input") mergeRecord(input, record);
      if (currentGroup === "output") mergeRecord(output, record);
    }
  }

  return {
    columns: allColumns,
    totals,
    input: [...input.values()],
    output: [...output.values()],
  };
}

async function resolveTprRange({ feeNo, startDate, endDate, nisBase, fetchImpl }) {
  const fallbackEnd = endDate || todayText();
  if (startDate) return { startDate, endDate: fallbackEnd };

  const indexUrl = `${nisBase.replace(/\/$/, "")}/HISVIEW/Tpr_Index?feeno=${encodeURIComponent(feeNo)}`;
  const response = await fetchImpl(indexUrl);
  if (!response.ok) return { startDate: fallbackEnd, endDate: fallbackEnd };
  const html = await response.text();
  return {
    startDate: extractMinDate(html) || inputValue(html, "start_date") || fallbackEnd,
    endDate: inputValue(html, "end_date") || fallbackEnd,
  };
}

function buildTableGrid(html) {
  const grid = [];
  const rowSpans = [];
  const rows = [...String(html || "").matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];

  for (const rowMatch of rows) {
    const rowClass = attrValue(rowMatch[1], "class");
    const cells = extractCells(rowMatch[2]);
    const row = [];
    let column = 0;

    for (const cell of cells) {
      while (rowSpans[column]?.remaining > 0) {
        row[column] = rowSpans[column].cell;
        rowSpans[column].remaining -= 1;
        column += 1;
      }

      const colspan = Number(attrValue(cell.attrs, "colspan") || 1);
      const rowspan = Number(attrValue(cell.attrs, "rowspan") || 1);
      const parsed = {
        text: cleanText(cell.html),
        title: cleanText(attrValue(cell.attrs, "title")),
        rowClass,
      };

      for (let i = 0; i < colspan; i += 1) {
        row[column + i] = parsed;
        if (rowspan > 1) {
          rowSpans[column + i] = { cell: parsed, remaining: rowspan - 1 };
        }
      }
      column += colspan;
    }

    while (rowSpans[column]?.remaining > 0) {
      row[column] = rowSpans[column].cell;
      rowSpans[column].remaining -= 1;
      column += 1;
    }

    if (row.some((cell) => cell?.text)) grid.push(row);
  }

  return grid;
}

function extractCells(rowHtml) {
  return [...String(rowHtml || "").matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((match) => ({
    attrs: match[1] || "",
    html: match[2] || "",
  }));
}

function extractDateColumns(row) {
  return row
    .slice(3)
    .filter((cell, index, cells) => cell?.text && cells.findIndex((other) => other?.text === cell.text) === index)
    .map((cell) => ({ date: cleanText(cell.text) }));
}

function extractDailyValues(row, columns) {
  return columns.map((column, index) => {
    const cell = row[3 + index * 2] || {};
    return {
      date: column.date,
      value: cleanText(cell.text || ""),
      detail: cleanText(cell.title || ""),
    };
  });
}

function extractTotalValues(row, columns) {
  return columns.map((column, index) => {
    const raw = cleanText(row[3 + index * 2]?.text || "");
    const match = raw.match(/^([^/]+)\/([^(]+)(?:\(([^)]+)\))?/);
    return {
      date: column.date,
      input: cleanText(match?.[1] || ""),
      output: cleanText(match?.[2] || ""),
      balance: cleanText(match?.[3] || ""),
      raw,
    };
  }).filter((item) => item.raw);
}

function mergeRecord(map, record) {
  const existing = map.get(record.item);
  if (!existing) {
    map.set(record.item, record);
    return;
  }
  existing.values.push(...record.values);
}

function firstMeaningfulItem(texts) {
  return texts.find((text) => text && !/輸入|輸出|總量|日期|時間/.test(text)) || "";
}

function inputValue(html, name) {
  const match = String(html || "").match(new RegExp(`<input\\b[^>]*name=["']${name}["'][^>]*>`, "i"));
  return match ? cleanText(attrValue(match[0], "value")) : "";
}

function extractMinDate(html) {
  const match = String(html || "").match(/minDate\s*=\s*new Date\(['"](\d{4}\/\d{2}\/\d{2})/i);
  return match ? match[1] : "";
}

function attrValue(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? htmlDecode(match[1]) : "";
}

function todayText() {
  const now = new Date();
  return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
}

function cleanText(value) {
  return htmlDecode(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
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
