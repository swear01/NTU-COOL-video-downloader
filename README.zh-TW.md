# NTU COOL 影片下載器

這是一個純 Chromium 擴充套件，用來把新版 NTU COOL 原生 DASH 影片下載成 MP4。它會從已登入的 NTU COOL 分頁捕捉影片 manifest，平行下載影像與音訊片段，在瀏覽器內完成封裝，再交給瀏覽器內建下載管理器。

## 支援範圍

- Google Chrome
- Brave
- Microsoft Edge
- 其他支援 Manifest V3 offscreen document 的桌面 Chromium 瀏覽器

Windows、macOS、Linux 使用同一份擴充套件。YouTube 與登入自動化不在目前範圍內。

## 安裝

1. 下載並解壓縮 release。
2. 開啟瀏覽器的擴充功能頁面。
3. 啟用「開發人員模式」。
4. 選擇「載入未封裝項目」，並指定此資料夾。

## 使用

1. 開啟 NTU COOL 原生影片並等待播放器載入。
2. 開啟擴充套件。
3. 點擊「Download video」。
4. 下載及影音封裝期間保持瀏覽器開啟。完成後，MP4 會交給瀏覽器原本的下載管理器。

擴充套件會自動選擇最高畫質，並在 4 到 64 路之間動態調整平行下載數量。

## 開發

```sh
npm install
npm test
```

MP4Box.js 是唯一的 runtime dependency。瀏覽器模組與授權檔已放在 `vendor/`，release 使用者不需要安裝 Node.js 或 npm。

## 授權

本專案採 MIT License，詳見 `LICENSE`。MP4Box.js 的 BSD-3-Clause 授權位於 `vendor/MP4Box.LICENSE`。
