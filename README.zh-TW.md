# NTU COOL 影片下載器

[English](README.md)

小而美的 Chromium 擴充套件，用來把 NTU COOL 原生影片下載成 MP4。它直接使用瀏覽器中已開啟的登入狀態，不做登入自動化、不需要本機 helper，也不使用外部服務。

## 功能

- 不讀取 Cookie，直接捕捉目前播放器產生的簽章 DASH manifest。
- 自動選擇 NTU COOL 提供的最高影片解析度，並包含音訊。
- 在 4 到 64 路之間自動調整平行下載數量。
- 完全在瀏覽器內合併 H.264 影像與 AAC 音訊。
- 完成後交給瀏覽器原本的下載管理器。
- 不同分頁互不干擾；分頁導覽或關閉時會清除捕捉到的網址。

## 支援範圍

同一份擴充套件支援 Windows、macOS、Linux，以及目前版本的 Chrome、Brave、Edge 和其他支援 Manifest V3 offscreen document 的 Chromium 瀏覽器。

目前支援新版 NTU COOL 原生 DASH 播放器。YouTube embed、登入自動化、Firefox、Safari 與其他串流格式不在範圍內。

## 安裝

1. 下載並解壓縮 release 套件。
2. 開啟瀏覽器擴充功能頁面，例如 `chrome://extensions`。
3. 啟用「開發人員模式」。
4. 選擇「載入未封裝項目」，並指定解壓縮後的資料夾。

## 使用

1. 正常登入 NTU COOL。
2. 開啟原生影片並等待播放器載入。
3. 開啟擴充套件，點擊「Download video」。
4. 下載及封裝期間保持瀏覽器開啟。

處理完成後，MP4 會出現在瀏覽器原本的下載管理器，並遵守使用者既有的下載位置設定。

## 權限與隱私

| 權限 | 用途 |
| --- | --- |
| `activeTab` | 只有使用者開啟擴充套件時，才讀取目前分頁標題作為 MP4 檔名。 |
| `webRequest` | 偵測原生播放器的 `manifest.mpd` 請求，不修改網路流量。 |
| `storage` | 將最新 manifest URL 放在記憶體型的 `storage.session`，避免 service worker 休眠後遺失。 |
| `offscreen` | popup 關閉後繼續下載及封裝 MP4。 |
| `downloads` | 將完成的 MP4 交給瀏覽器下載管理器。 |
| `https://*.dlc.ntu.edu.tw/*` | 將網路存取限制在臺大影片播放器與媒體主機。 |

擴充套件無法讀取一般瀏覽紀錄、Cookie、密碼或其他網站，也沒有分析、遙測、廣告或遠端程式碼。捕捉到的簽章網址只存在目前瀏覽器工作階段，分頁導覽或關閉時即移除。

## 開發

```sh
npm install
npm test
```

MP4Box.js 2.4.1 是唯一的 runtime dependency。瀏覽器模組與 BSD-3-Clause 授權檔已放在 `vendor/`，使用者不需要安裝 Node.js 或 npm；其餘程式只使用瀏覽器 API 與 JavaScript 標準函式庫。

## 授權

本專案採 MIT License，詳見 `LICENSE`。MP4Box.js 的授權檔位於 `vendor/MP4Box.LICENSE`。
