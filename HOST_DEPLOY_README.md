# 院內查房工具主機部署說明

## 是否可行

可行。把一台可長時間開機、能連 Onepage/NIS 內網的院內電腦當主機，其他手機、平板、院內電腦只要能連到同一個內網，就可用同一個工作台網址查詢。

建議固定網址：

```text
http://WARD-TOOLS:8766/
```

如果院內 DNS 無法解析主機名，先用該主機目前 IP：

```text
http://主機IP:8766/
```

## 要搬到院內主機的檔案

請搬整個打包資料夾內的檔案，至少需要：

- `app/`
- `Start_Workbench_LAN.cmd`
- `Setup_Stable_Intranet_Link_Admin.cmd`
- `Allow_Workbench_Firewall_Admin.cmd`
- `HOST_DEPLOY_README.md`

不要搬：

- `app/.local/sessions.json`
- `app/.local/audit.ndjson`

這兩個是本機登入 session 與稽核紀錄。新主機應重新登入，不要複製舊 token。

## 院內主機第一次設定

1. 將打包資料夾複製到院內主機，例如：

```text
C:\clinical-tools
```

2. 用系統管理員身分執行：

```text
Setup_Stable_Intranet_Link_Admin.cmd
```

這會：

- 開放 Windows 防火牆 TCP `8766`
- 嘗試將主機名改成 `WARD-TOOLS`

改名成功後通常要重開機。

3. 重開機後執行：

```text
Start_Workbench_LAN.cmd
```

4. 在院內手機或平板開：

```text
http://WARD-TOOLS:8766/
```

如果主機名無法解析，先改用啟動視窗顯示的 IP 連結。

## Node.js runtime

目前啟動檔會優先找 Codex 內建 Node：

```text
%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

如果院內主機沒有這個 runtime，請安裝 Node.js LTS，或把 Node runtime 一起複製過去，並確認 `node` 指令可用。

確認方式：

```cmd
node --version
```

## 多使用者登入原則

工作台不共用 Onepage 帳密。每位使用者打開工作台後，應使用自己的 Onepage 帳號密碼登入。

目前 session 存在主機本機：

```text
app\.local\sessions.json
```

請勿把這個檔案放到 GitHub、Discord 或其他共享位置。

## 若手機無法連線

依序檢查：

1. 主機上 `Start_Workbench_LAN.cmd` 是否正在執行。
2. 主機本機可否開 `http://127.0.0.1:8766/`。
3. 同內網設備可否開 `http://主機IP:8766/`。
4. Windows 防火牆是否允許 TCP `8766`。
5. 院內 Wi-Fi 是否禁止裝置互連。
6. 院內 DNS 是否能解析 `WARD-TOOLS`。

如果 `http://主機IP:8766/` 可用，但 `http://WARD-TOOLS:8766/` 不可用，代表是 DNS/主機名解析問題，需要資訊室加 DNS alias 或固定 DHCP。
