import assert from "node:assert/strict";
import { fetchOnepageClinicalSource } from "./onepage_clinical_parser.mjs";

async function fetchImaging(rows) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url).pathname.split("/").at(-1);
    calls.push({ endpoint, params: JSON.parse(options.body || "{}") });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(endpoint === "image.list" ? rows : []),
    };
  };
  const result = await fetchOnepageClinicalSource({
    source: "imaging",
    feeno: "F-current",
    chartNo: "C-1",
    authToken: "test-token",
    onepageBase: "http://onepage.test",
    fetchImpl,
  });
  return { result, calls };
}

const oldAdmission = await fetchImaging([{
  chr_no: "C-1",
  fee_no: "F-old",
  date: "2026/07/02",
  title: "CT",
  impression: "Rectal cancer",
}]);
assert.equal(oldAdmission.result.rows.length, 1, "verified imaging from another admission must be kept as history");
assert.equal(oldAdmission.result.rows[0].admissionScope, "history");
const imageRequest = oldAdmission.calls.find((call) => call.endpoint === "image.list");
assert.equal(imageRequest.params.fee_no, "F-current");
assert.equal(imageRequest.params.feeno, "F-current");
assert.equal(imageRequest.params.current, false);

const currentAdmission = await fetchImaging([{
  chr_no: "C-1",
  fee_no: "F-current",
  date: "2026/07/15",
  title: "CT",
  impression: "Current admission finding",
}]);
assert.equal(currentAdmission.result.rows.length, 1, "current-admission imaging must remain available");
assert.equal(currentAdmission.result.rows[0].admissionScope, "current");

async function fetchPathology(rows) {
  const fetchImpl = async (url) => {
    const endpoint = new URL(url).pathname.split("/").at(-1);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(endpoint === "patho.list" ? rows : []),
    };
  };
  return fetchOnepageClinicalSource({
    source: "pathology",
    feeno: "F-current",
    chartNo: "C-1",
    authToken: "test-token",
    onepageBase: "http://onepage.test",
    fetchImpl,
  });
}

const unverifiedPathology = await fetchPathology([{ date: "2025/02/04", diagnosis: "Rectal cancer" }]);
assert.equal(unverifiedPathology.rows.length, 0, "pathology without patient and admission identifiers must be excluded");

const verifiedHistoricalPathology = await fetchPathology([{
  chr_no: "C-1",
  fee_no: "F-old",
  date: "2025/02/04",
  diagnosis: "Verified historical diagnosis",
}]);
assert.equal(verifiedHistoricalPathology.rows.length, 1);
assert.equal(verifiedHistoricalPathology.rows[0].admissionScope, "history");

async function fetchSurgeries(rows, episode = {}) {
  const fetchImpl = async (url) => {
    const endpoint = new URL(url).pathname.split("/").at(-1);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(endpoint === "surgery.list" ? rows : []),
    };
  };
  return fetchOnepageClinicalSource({
    source: "surgeries",
    feeno: "F-current",
    chartNo: "C-1",
    admissionStart: episode.admissionStart || "",
    admissionEnd: episode.admissionEnd || "",
    authToken: "test-token",
    onepageBase: "http://onepage.test",
    fetchImpl,
  });
}

const unverifiedSurgery = await fetchSurgeries([{ date: "2021/12/17", procedure: "Rectal cancer surgery" }]);
assert.equal(unverifiedSurgery.rows.length, 1, "unscoped surgery remains visible for manual review");
assert.equal(unverifiedSurgery.rows[0].admissionScope, "unverified", "unscoped surgery must never become history evidence");

const verifiedHistoricalSurgery = await fetchSurgeries([{ chr_no: "C-1", fee_no: "F-old", date: "2021/12/17", procedure: "Verified prior surgery" }]);
assert.equal(verifiedHistoricalSurgery.rows[0].admissionScope, "history");

const foreignSurgery = await fetchSurgeries([{ chr_no: "C-other", fee_no: "F-old", date: "2021/12/17", procedure: "Foreign surgery" }]);
assert.equal(foreignSurgery.rows.length, 0, "other-patient surgery must be excluded");

const dateMatchedCurrentSurgery = await fetchSurgeries([{
  chr_no: "C-1", date: "2026/07/15", procedure: "Right hemicolectomy", diag_post: "Colon tumor",
}], { admissionStart: "2026/07/12", admissionEnd: "2026/07/17" });
assert.equal(dateMatchedCurrentSurgery.rows[0].admissionScope, "current", "matching chart plus operation date in this admission must be current even when fee_no is absent");
assert.equal(dateMatchedCurrentSurgery.rows[0].admissionEvidence, "date_in_current_admission");

const dateMatchedHistoricalSurgery = await fetchSurgeries([{
  chr_no: "C-1", date: "2025/07/15", procedure: "Right hemicolectomy", diag_post: "Colon tumor",
}], { admissionStart: "2026/07/12", admissionEnd: "2026/07/17" });
assert.equal(dateMatchedHistoricalSurgery.rows[0].admissionScope, "history", "same-chart surgery before this admission must be historical");

const dateMissingSurgery = await fetchSurgeries([{
  chr_no: "C-1", procedure: "Right hemicolectomy", diag_post: "Colon tumor",
}], { admissionStart: "2026/07/12", admissionEnd: "2026/07/17" });
assert.equal(dateMissingSurgery.rows[0].admissionScope, "unverified", "missing fee_no and surgery date must never influence diagnosis or history");
