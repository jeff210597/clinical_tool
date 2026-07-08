# Onepage 查房工作台 MVP

這是目前的單機版查房工作台。使用者先用自己的 Onepage 帳號登入，後端會暫存在記憶體中的 Onepage token，再用病歷號或床號解析目前住院資料。

## 啟動

建議直接使用專案根目錄的批次檔：

```powershell
.\Start_Workbench_NoPlaywright.cmd
```

服務預設網址：

```text
http://127.0.0.1:8766
```

若要讓同一個內網中的手機或平板連線，需改用：

```powershell
$env:API_HOST="0.0.0.0"
$env:API_PORT="8766"
& "C:\Users\jeff0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" .\app\server.mjs
```

## Onepage 登入除錯

若登入失敗，使用：

```powershell
.\Start_Debug_Visible_Browser.cmd
```

這會在登入 Onepage 時顯示 Edge/Chrome 視窗，方便確認欄位 selector、帳密、額外驗證或 token 取得問題。

## 已接上的資料

- Onepage 目前住院清單解析：病歷號 / 床號 -> 本次住院 feeNo。
- NIS 住院醫囑 parser。
- NIS 成人入院評估單 parser。
- 本機 rule-based AI 判讀摘要。
- 查詢 audit log：`app/.local/audit.ndjson`。

## 尚未完成

- Labs parser。
- Vital/iTPR parser。
- TPR 與輸入輸出 parser。
- 影像 parser。
- 手術紀錄 parser。
- Progress / 入院病摘 / 出院病摘 parser。

## 檢查

```powershell
cd app
npm run check
```
