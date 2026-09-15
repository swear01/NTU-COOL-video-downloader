# Chrome Web Store submission

## Distribution

- Visibility: Public
- Regions: All regions
- Pricing: Free
- Primary language: Chinese (Traditional)
- Category: Tools

## Name

NTU COOL Video Downloader

## Summary

將已獲授權觀看的 NTU COOL 原生課程影片下載為 MP4，完全在瀏覽器本機處理。

## Detailed description

NTU COOL Video Downloader 是一個小而專注的 Chromium 擴充套件，讓使用者將自己已獲授權觀看的 NTU COOL 原生課程影片儲存為含聲音的 MP4。

使用者正常登入 NTU COOL、開啟原生影片並按下擴充套件的下載按鈕即可；也能從擴充套件右鍵選單開啟批量下載頁面，貼上多個單支影片頁面網址。批量模式最多同時處理兩支影片，來源查找與下載可重疊；使用既有登入狀態直接取得授權表單及影片來源，不會逐支開啟影片分頁。擴充套件會自動選擇平台提供的最高解析度，在瀏覽器內下載並合併影像與音訊，完成後交給瀏覽器原本的下載管理器。

- 不自動登入，也不讀取或匯出 Cookie、密碼；授權請求由瀏覽器自動帶入既有登入 Cookie
- 不繞過登入、存取控制或 DRM
- 不支援 YouTube embed
- 沒有分析、遙測、廣告或開發者代管伺服器；只連線至官方 COOL 服務
- 所有 MP4 組裝都在使用者瀏覽器本機完成
- 英文與繁體中文介面，自動跟隨亮色或深色模式
- 僅供下載使用者已獲合法授權存取的內容

本專案為獨立開源專案，與國立臺灣大學沒有隸屬或背書關係。

## Single purpose

Download native NTU COOL course videos that the user is already authorized to access and save them locally as MP4 files.

## Permission justifications

- `activeTab`: Read the active tab title only after the user opens the extension, to create the MP4 filename.
- `alarms`: Limit each batch source lookup to 30 seconds.
- `contextMenus`: Add the user-invoked shortcut that opens the batch-download page.
- `downloads`: Send the locally assembled MP4 to the browser's normal download manager.
- `offscreen`: Parse the LTI form, resolve the authorized source, and continue downloading/assembling the MP4 after the popup closes.
- `storage`: Retain temporary manifest, job, and batch-queue state across Manifest V3 service-worker suspension.
- `webRequest`: Observe native NTU COOL `manifest.mpd` requests without modifying network traffic.
- Host access `https://*.dlc.ntu.edu.tw/*`: Access official NTU COOL video authorization, metadata, and media hosts.
- Optional host access `https://cool.ntu.edu.tw/*`: Requested only from the batch page after the user selects Start, to fetch the pasted pages with the existing login and obtain fresh video authorization.

## Data-use declarations

- Website content: Yes. Module HTML and video metadata are parsed for authorization and source lookup; video/audio fragments are assembled locally into the requested MP4.
- Web browsing activity: Yes. The extension temporarily observes signed NTU COOL media request URLs solely for the user-facing download action.
- Authentication information: Yes, temporarily. The extension forwards COOL-provided signed LTI launch fields only to the official COOL video endpoint. It does not read passwords or cookie values, and does not persist the form or include it in reports.
- Personally identifiable information: Yes, temporarily. COOL LTI forms may include name, email address, account identifiers, and course roles; these are used only in the official video authorization request and are not persisted or sent to the developer.
- Financial information: No.
- Personal communications: No.
- User data sold or shared with the developer: No. LTI fields are transmitted only between the official COOL services for the requested video authorization.
- Data used for advertising, analytics, or profiling: No.
- Remote code: No.

Privacy policy URL:
https://github.com/swear01/NTU-COOL-video-downloader/blob/main/PRIVACY.md

Homepage URL:
https://github.com/swear01/NTU-COOL-video-downloader

Support URL:
https://github.com/swear01/NTU-COOL-video-downloader/issues

## Test instructions

1. Sign in with a test account that is authorized to view an NTU COOL native course recording.
2. Open the authorized course video and wait for the native player to load.
3. Open the extension popup. It should report `Video found.`
4. Select `Download video` and keep the browser open.
5. Confirm that progress is displayed and that the completed MP4 appears in browser downloads with video and audio.
6. Right-click the extension action and open the batch page.
7. Paste two authorized direct `/courses/.../modules/items/...` video-page URLs, one per line, and select Start.
8. Confirm that two videos can run concurrently with separate progress and no per-video tabs; Pause and Start suspend and resume both active items, Stop cancels the queue, and completed items use their COOL video titles as filenames.

The extension does not automate login or bypass access control. Never commit personal credentials to this repository; any reviewer credentials must be a dedicated authorized test account supplied only through the Developer Dashboard.
