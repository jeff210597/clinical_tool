const DEFAULT_ONEPAGE_BASE = "http://10.125.10.11:8040";
const DEFAULT_APP_TOKEN = "app_tok_9c34eefcdfffc2e66c30f4cb6885e22d";

export async function resolveCurrentAdmission({
  query,
  onepageBase = DEFAULT_ONEPAGE_BASE,
  appToken = process.env.ONEPAGE_APP_TOKEN || DEFAULT_APP_TOKEN,
  authToken = process.env.ONEPAGE_AUTH_TOKEN || "",
  userId = process.env.ONEPAGE_USER_ID || "",
  fetchImpl = fetch,
}) {
  const ref = String(query || "").trim();
  if (!ref) throw new Error("query is required");
  if (!authToken) {
    return {
      status: "missing_auth",
      message: "Onepage auth token is missing. Please login first.",
    };
  }

  const collected = await collectCandidates({ ref, onepageBase, appToken, authToken, userId, fetchImpl });
  if (!collected.ok) {
    return {
      status: "onepage_error",
      message: collected.message,
      candidateCount: collected.candidates.length,
    };
  }

  const match = findAdmissionMatch(ref, collected.candidates);
  if (!match) {
    const profileHint = collected.profileFound ? " profile was found but no current admission/fee_no matched." : "";
    return {
      status: "not_found",
      message: `No current admission matched ${ref}. candidates=${collected.candidates.length}.${profileHint}`,
      candidateCount: collected.candidates.length,
    };
  }

  return {
    status: "ok",
    admission: normalizeAdmission(match),
    candidateCount: collected.candidates.length,
  };
}

async function collectCandidates({ ref, onepageBase, appToken, authToken, userId, fetchImpl }) {
  const candidates = [];
  const errors = [];
  let profileFound = false;

  for (const params of profileLookupAttempts(ref)) {
    try {
      const profile = await postOnepageApi({
        onepageBase,
        path: "pt.get",
        params,
        appToken,
        authToken,
        fetchImpl,
      });
      if (profile && typeof profile === "object" && !Array.isArray(profile)) {
        profileFound = true;
        const admission = admissionFromProfile(profile);
        if (admission) candidates.push(admission);
      }
    } catch (error) {
      errors.push(`pt.get ${JSON.stringify(params)} => ${error.message}`);
    }
  }

  for (const params of ipdListAttempts(ref, userId)) {
    try {
      const result = await postOnepageApi({
        onepageBase,
        path: "ipd.list",
        params,
        appToken,
        authToken,
        fetchImpl,
      });
      if (Array.isArray(result)) candidates.push(...result);
      else if (result && typeof result === "object") candidates.push(result);
    } catch (error) {
      errors.push(`ipd.list ${JSON.stringify(params)} => ${error.message}`);
    }
  }

  if (!candidates.length && !profileFound && errors.length) {
    return {
      ok: false,
      message: `Onepage lookup failed. ${errors.join(" | ")}`,
      candidates: [],
      profileFound,
    };
  }

  return { ok: true, candidates: uniqueAdmissions(candidates), profileFound };
}

function profileLookupAttempts(ref) {
  const common = { ipd: true, with_ac: true };
  return [
    { no: ref, ...common },
    { chr_no: ref, ...common },
    { bed_no: ref, ...common },
    { id_no: ref, ...common },
  ];
}

function ipdListAttempts(ref, userId) {
  const attempts = [];
  if (userId) {
    attempts.push({ doc_id: userId, combine_care_doc_id: userId, current: true });
  }
  attempts.push(
    { chr_no: ref, current: true },
    { bed_no: ref, current: true },
    { fee_no: ref, current: true },
  );
  return attempts;
}

async function postOnepageApi({ onepageBase, path, params, appToken, authToken, fetchImpl }) {
  const base = String(onepageBase || DEFAULT_ONEPAGE_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/api/${path}`, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "origin": base,
      "referer": `${base}/mypage`,
      "x-app-token": appToken,
      "x-wfauth": authToken,
    },
    body: JSON.stringify(params || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    const body = text ? ` ${text.slice(0, 200)}` : "";
    throw new Error(`HTTP ${response.status}${body}`);
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function admissionFromProfile(profile) {
  const ipd = firstObject(profile.ipd, profile.current_ipd, profile.admission, profile.currentAdmission);
  const admission = {
    chartNo: firstValue(profile.chr_no, profile.chart_no, profile.chartNo, profile.histno, profile.patient_id, profile.no),
    name: firstValue(profile.name, profile.pt_name, profile.patient_name),
    bedNo: firstValue(ipd?.bed_no, ipd?.bed, ipd?.bedNo, profile.bed_no, profile.bedNo),
    feeNo: firstValue(ipd?.fee_no, ipd?.feeno, ipd?.feeNo, ipd?.fee_no_ori, profile.fee_no, profile.feeno, profile.feeNo),
    dept: firstValue(ipd?.dept_name, ipd?.dept, ipd?.div_name, profile.dept_name, profile.dept),
    admitDate: admissionStartDate(ipd, profile),
    dischargeDate: admissionEndDate(ipd, profile),
    status: admissionStatus(ipd, profile),
    current: ipd?.current,
    raw: profile,
  };

  if (!admission.chartNo && !admission.bedNo && !admission.feeNo) return null;
  if (ipd && ipd.exist === false) return null;
  return admission;
}

function findAdmissionMatch(ref, candidates) {
  const normalized = normalizeKey(ref);
  const exact = candidates.find((item) => admissionMatches(normalizeAdmission(item), normalized));
  if (exact) return exact;

  const current = candidates.find((item) => {
    const admission = normalizeAdmission(item);
    return admission.current !== false && (admission.chartNo || admission.bedNo || admission.feeNo);
  });
  return current || null;
}

function admissionMatches(admission, normalized) {
  return (
    normalizeKey(admission.chartNo) === normalized ||
    normalizeKey(admission.bedNo) === normalized ||
    normalizeKey(admission.feeNo) === normalized ||
    normalizeKey(admission.name) === normalized
  );
}

function normalizeAdmission(item) {
  const ipd = firstObject(item.ipd, item.current_ipd, item.admission, item.currentAdmission);
  return {
    chartNo: firstValue(item.chr_no, item.chart_no, item.chartNo, item.histno, item.patient_id, item.no, item.chartNo),
    name: firstValue(item.name, item.pt_name, item.patient_name),
    bedNo: firstValue(item.bed_no, item.bed, item.bedNo, ipd?.bed_no, ipd?.bed, ipd?.bedNo),
    feeNo: firstValue(item.fee_no, item.feeno, item.feeNo, ipd?.fee_no, ipd?.feeno, ipd?.feeNo, ipd?.fee_no_ori),
    dept: firstValue(item.dept_name, item.dept, item.div_name, ipd?.dept_name, ipd?.dept, ipd?.div_name),
    admitDate: admissionStartDate(item, ipd),
    dischargeDate: admissionEndDate(item, ipd),
    status: admissionStatus(item, ipd),
    current: item.current ?? ipd?.current,
    raw: item.raw || item,
  };
}

function admissionStartDate(...objects) {
  return firstValueFromObjects(objects, [
    "start",
    "start_date",
    "startDate",
    "admit_date",
    "admitDate",
    "admission_date",
    "admissionDate",
    "in_date",
    "inDate",
    "ipd_date",
    "ipdDate",
    "begin_date",
    "beginDate",
    "fee_start",
    "feeStart",
  ]);
}

function admissionEndDate(...objects) {
  return firstValueFromObjects(objects, [
    "end",
    "end_date",
    "endDate",
    "discharge_date",
    "dischargeDate",
    "dc_date",
    "dcDate",
    "out_date",
    "outDate",
    "leave_date",
    "leaveDate",
    "fee_end",
    "feeEnd",
  ]);
}

function admissionStatus(...objects) {
  const status = firstValueFromObjects(objects, ["status", "status_name", "statusName", "ipd_status", "ipdStatus"]);
  if (/出院|discharge|closed|結案/i.test(status)) return "discharged";
  if (/住院|current|active|open/i.test(status)) return "inpatient";
  return admissionEndDate(...objects) ? "discharged" : "inpatient";
}

function firstValueFromObjects(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    for (const key of keys) {
      const text = firstValue(object[key]);
      if (text) return text;
    }
  }
  return "";
}

function uniqueAdmissions(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const admission = normalizeAdmission(item);
    const key = [admission.chartNo, admission.bedNo, admission.feeNo, admission.name].join("|");
    if (!key.replace(/\|/g, "") || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}
