import assert from "node:assert/strict";
import { parseAdultAdmissionAssessment } from "./adult_assessment_parser.mjs";

const html = `
  <p><label class="subtitle">入院原因</label><input type="text" value="痔瘡"></p>
  <p><label class="subtitle">內科病史</label><input type="radio" value="無"><input type="radio" value="有"></p>
  <p><label class="subtitle">外科病史</label><input type="radio" value="無"><input type="radio" value="有"></p>
  <script>
    set_for_txt('param_ipd_reason', '長期便祕，懷疑是惡性腫瘤，建議入院詳檢。');
    set_for_rb('param_im_history', '有');
    set_for_txt('param_im_history_item_other_txt', '躁鬱症，胃潰瘍。');
    set_for_rb('param_su_history', '有');
    set_for_txt('param_su_history_surgery_txt', '14年前人工流產。');
    set_for_rb('param_other_history', '無');
  </script>`;

const parsed = parseAdultAdmissionAssessment(html);
assert.equal(parsed.admissionReason, "長期便祕，懷疑是惡性腫瘤，建議入院詳檢。");
assert.match(parsed.pastHistory, /內科病史: 躁鬱症，胃潰瘍。/);
assert.match(parsed.pastHistory, /外科病史: 14年前人工流產。/);
assert.doesNotMatch(parsed.pastHistory, /痔瘡|無/);
console.log("adult assessment parser test OK");
