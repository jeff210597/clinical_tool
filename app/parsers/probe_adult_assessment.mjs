const url = process.argv[2];

if (!url) {
  console.error("usage: node probe_adult_assessment.mjs <url>");
  process.exit(1);
}

const html = await fetch(url).then((response) => response.text());

const labels = [...html.matchAll(/<label[^>]*class=["']subtitle["'][^>]*>([\s\S]*?)<\/label>/gi)]
  .map((match) => match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
  .filter(Boolean);

const interesting = labels.filter((label) =>
  /入院|病史|疾病|手術|過去|診斷|意識|活動|解尿|大便|照顧|特殊|疼痛|過敏/.test(label)
);

console.log(JSON.stringify({
  labelCount: labels.length,
  interesting: [...new Set(interesting)].slice(0, 100),
}, null, 2));
