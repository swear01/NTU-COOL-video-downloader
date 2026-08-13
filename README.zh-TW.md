# NTU COOL 影片下載器

[![CI](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/ci.yml)
[![CodeQL](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml/badge.svg)](https://github.com/swear01/NTU-COOL-video-downloader/actions/workflows/codeql.yml)
[![最新版本](https://img.shields.io/github/v/release/swear01/NTU-COOL-video-downloader)](https://github.com/swear01/NTU-COOL-video-downloader/releases/latest)
[![授權：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md)

[隱私權政策](PRIVACY.md)

小而美的 Chromium 擴充套件，用來把 NTU COOL 原生影片下載成 MP4。它直接使用瀏覽器中已開啟的登入狀態，不做登入自動化、不需要本機 helper，也不使用外部服務。

## 功能

- 不讀取 Cookie，直接捕捉目前播放器產生的簽章 DASH manifest。
- 自動選擇 NTU COOL 提供的最高影片解析度，並包含音訊。
- 在 4 到 64 路之間自動調整平行下載數量。
- 完全在瀏覽器內合併 H.264 影像與 AAC 音訊。
- 完成後交給瀏覽器原本的下載管理器。
- 可貼上多個 NTU COOL 單支影片頁面連結，依序批量下載。
- 提供英文與繁體中文介面。
- 不同分頁互不干擾；分頁導覽或關閉時會清除捕捉到的網址。

## 支援範圍

同一份擴充套件支援 Windows、macOS、Linux，以及 Chrome 116 以上、Brave、Edge 和其他相容的 Chromium 瀏覽器。介面會自動跟隨作業系統的亮色或深色外觀。

目前支援新版 NTU COOL 原生 DASH 播放器。YouTube embed、登入自動化、Firefox、Safari 與其他串流格式不在範圍內。

其他下載類擴充功能（例如圖片或影片下載器）可以與本擴充功能並存。本擴充功能只在自己產生的 MP4 存檔期間參與瀏覽器的檔名決定流程，因此不會覆蓋其他擴充功能選擇的檔名。

## 安裝

1. 從[最新 Release](https://github.com/swear01/NTU-COOL-video-downloader/releases/latest)下載 ZIP 與 `SHA256SUMS`，再將 ZIP 解壓縮到新的資料夾。
2. 開啟瀏覽器擴充功能頁面，例如 `chrome://extensions`。
3. 啟用「開發人員模式」。
4. 選擇「載入未封裝項目」，並指定解壓縮後的資料夾。

## 使用

1. 正常登入 NTU COOL。
2. 開啟原生影片並等待播放器載入。
3. 開啟擴充套件，點擊「下載影片」。
4. 下載及封裝期間保持瀏覽器開啟。

處理完成後，MP4 會出現在瀏覽器原本的下載管理器，並遵守使用者既有的下載位置設定。

批量下載時，在擴充套件圖示上按右鍵，選擇「開啟 COOL 批量下載」。將單支影片頁面網址一行貼上一個，再按「開始」。「暫停」會暫停目前傳輸，「停止」會取消整個佇列。批量模式只接受 `/courses/.../modules/items/...` 直接連結。

## 權限與隱私

| 權限 | 用途 |
| --- | --- |
| `activeTab` | 只有使用者開啟擴充套件時，才讀取目前分頁標題作為 MP4 檔名。 |
| `alarms` | 批量頁面沒有出現原生影片時停止等待。 |
| `contextMenus` | 在擴充套件右鍵選單加入由使用者觸發的批量下載入口。 |
| `webRequest` | 偵測原生播放器的 `manifest.mpd` 請求，不修改網路流量。 |
| `storage` | 將暫時的 manifest、工作與批量佇列狀態放在記憶體型的 `storage.session`，避免 service worker 休眠後遺失。 |
| `offscreen` | popup 關閉後繼續下載及封裝 MP4。 |
| `downloads` | 將完成的 MP4 交給瀏覽器下載管理器。 |
| `https://*.dlc.ntu.edu.tw/*` | 將網路存取限制在臺大影片媒體主機。 |
| 選用 `https://cool.ntu.edu.tw/*` | 只在使用者開始批量下載時請求，用來開啟貼上的頁面並讀取影片標題。 |

擴充套件無法讀取一般瀏覽紀錄、Cookie、密碼或其他網站，也沒有分析、遙測、廣告或遠端程式碼。捕捉到的簽章網址只存在目前瀏覽器工作階段，分頁導覽或關閉時即移除。

## Release 安全與驗證

每個 Pull Request 與 Release 都會執行測試、npm dependency audit、CodeQL 分析及 ClamAV 掃毒。Release ZIP 與 checksum 檔案會取得由 Sigstore 支援的 GitHub artifact attestation，使用者可以確認檔案確實由本 repo 的 Release workflow 產生。

下載兩個 Release 檔案後驗證 checksum：

```sh
sha256sum --check SHA256SUMS       # Linux
shasum -a 256 --check SHA256SUMS  # macOS
```

Windows 請在 PowerShell 執行 `Get-FileHash .\NTU-COOL-video-downloader-1.2.0.zip -Algorithm SHA256`，並和 `SHA256SUMS` 比對。

使用 [GitHub CLI](https://cli.github.com/)驗證建置來源簽章：

```sh
gh attestation verify NTU-COOL-video-downloader-1.2.0.zip \
  --repo swear01/NTU-COOL-video-downloader
```

請將版本號換成實際下載的 Release。Workflow actions 全部固定在明確 commit，ZIP 只包含執行所需檔案，完整原始碼也可公開檢查。Chrome 通常限制 Windows 與 macOS 安裝自行託管的擴充元件，因此本專案提供可驗證的 ZIP，透過「載入未封裝項目」跨平台安裝，而不宣稱自行簽署的 CRX 能在所有平台直接安裝。

## 開發

```sh
npm install
npm test
npm run package
```

MP4Box.js 2.4.1 是唯一的 runtime dependency。瀏覽器模組與 BSD-3-Clause 授權檔已放在 `vendor/`，使用者不需要安裝 Node.js 或 npm；其餘程式只使用瀏覽器 API 與 JavaScript 標準函式庫。

產生的 ZIP 遵循 Chrome 套件結構，`manifest.json` 直接位於壓縮檔根目錄；同一份 ZIP 可以上傳至相容的擴充元件後台，或解壓後透過「載入未封裝項目」安裝。

本專案為獨立專案，與國立臺灣大學沒有隸屬或背書關係；NTU COOL 名稱與 Logo 權利屬原權利人所有，此處僅用於識別相容性。

## 授權

本專案採 MIT License，詳見 `LICENSE`。MP4Box.js 的授權檔位於 `vendor/MP4Box.LICENSE`。
