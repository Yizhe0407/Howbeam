# 商店頁（Store listing 分頁）

## 名稱與摘要

這兩項都從 ZIP 裡的 manifest 讀取，後台不能直接改。要改的話，改 `extension/public/_locales/*/messages.json`，再重新打包。

| 欄位 | 英文（預設語系） | 繁體中文 |
| --- | --- | --- |
| 名稱 `extName` | Stepmark | Stepmark |
| 摘要 `extDescription` | Record clicks and auto-generate a step-by-step annotated image guide（69 字元） | 記錄點擊操作，自動產生逐步的圖解說明 |

官方規定摘要不能超過 132 個字元。名稱要清楚易懂，不能塞關鍵字。

## 詳細說明

官方建議開頭先用一句話說清楚這個擴充功能做什麼，接著寫一段概述，再列出主要功能。

依 Limited Use 政策，擴充功能只有在「功能有明顯寫在商店頁上」時，才能收集瀏覽活動。Stepmark 會記錄網址並截圖，所以說明裡要**明確寫出會截圖、會記錄網址**。下面的「Privacy」段落就是為了這件事，不要刪掉。

### 英文（貼到預設語系 English）

```text
Stepmark turns what you click in your browser into a step-by-step guide with screenshots and annotations.

Click the toolbar icon, choose a mode and start recording. Each click on a web page captures a screenshot, highlights the element you clicked and writes a short description. When you finish, edit the guide and export it.

Main features
• Two recording modes: Steps (one screenshot per click) and Mark (mark several points on one screen)
• Keep recording when you switch tabs or open another site (optional permission, asked only when you need it)
• Edit your guide: reorder steps, rewrite descriptions, add text, arrows, boxes, numbers, masks and crops
• Export as PDF, a single HTML file, Markdown (ZIP) or annotated images
• Automatic backup to a folder you choose, as .stepmark files you can import again
• English and Traditional Chinese interface

Privacy
• While you record, Stepmark takes screenshots of the visible page and saves the page address and the visible text of the element you click. It needs these to build your guide.
• Everything is stored only in your browser on this computer. There is no account, no server and no analytics, and nothing is uploaded.
• Screenshots show everything visible on the page. Use the mask tool to hide sensitive information before you export or share a guide.

Privacy policy: https://github.com/Yizhe0407/Stepmark/blob/main/chrome-web-store/privacy-policy.md
```

### 繁體中文（貼到 Chinese (Traditional) 語系）

```text
Stepmark 把你在瀏覽器裡的點擊操作，自動變成附截圖與標註的逐步教學。

點工具列圖示、選擇錄製模式後開始錄製。每在網頁上點一下，就會擷取一張截圖、框出你點的元素，並寫好一句說明。錄完之後可以編輯，再匯出成文件。

主要功能
• 兩種錄製模式：「步驟」每點一下拍一張；「標註」在同一個畫面上標出多個重點
• 切換分頁或跳到其他網站時可以繼續錄製（選用權限，需要時才會詢問）
• 編輯教學：調整步驟順序、修改說明，加上文字、箭頭、外框、編號、遮罩與裁切
• 匯出成 PDF、單一 HTML 檔、Markdown（ZIP）或已標註的圖片
• 自動備份到你選擇的資料夾，存成之後可以再匯入的 .stepmark 檔
• 介面支援繁體中文與英文

隱私
• 錄製時，Stepmark 會擷取目前可見頁面的截圖，並記錄網頁網址與你所點元素上的文字，用來產生教學。
• 所有資料只存在這台電腦的瀏覽器裡。沒有帳號、沒有伺服器、沒有分析工具，不會上傳任何資料。
• 截圖會拍下頁面上所有看得到的內容。匯出或分享前，請用遮罩工具蓋住敏感資訊。

隱私權政策：https://github.com/Yizhe0407/Stepmark/blob/main/chrome-web-store/privacy-policy.md
```

### 商店頁文字的限制

- 同一個關鍵字不自然地重複超過 5 次，會被判定為關鍵字堆砌（違規代碼 Yellow Argon）。上面兩份說明都沒有這個問題。
- 說明空白、缺少圖示或截圖會被退件（違規代碼 Yellow Zinc）。

## 分類與語言

- **分類**：⚠ 未確認。官方文件沒有列出目前的分類清單，Google 只在 2023 年改版時提到新增了分類。請在後台下拉選單選最符合「製作操作教學文件」用途的一項。
- **語言**：用來讓使用者以自己的語言搜尋。擴充功能有 `en` 與 `zh_TW` 兩個語系，詳細說明、截圖、影片可以依語系分別提供，宣傳圖不行。

## 圖示

| 規格 | 要求 | Stepmark 現況 |
| --- | --- | --- |
| 尺寸 | 128×128 PNG，放在 ZIP 裡 | 建置時從 `extension/assets/brand/*.svg` 產生為 `icon/128.png`，已在 ZIP 裡 |
| 留白 | 圖案本身 96×96，四邊各留 16px 透明 | 2026-10-18 實測，圖案範圍是 80×68（x 24–103，y 30–97），符合 |
| 外觀 | 淺色與深色背景都清楚；不要外框、不要大陰影；正面朝前 | 上傳前用淺色、深色背景各看一次 |

後台如果另外要求上傳商店圖示，就用 `extension/.output/chrome-mv3/icon/128.png`。

## 截圖（必填）

| 規格 | 要求 |
| --- | --- |
| 尺寸 | **1280×800** 或 640×400，建議用 1280×800。所有截圖都會被縮小成 640×400 顯示，所以字不能太小。 |
| 數量 | 至少 1 張，最多 5 張，官方建議放滿 5 張 |
| 版面 | 直角、不留邊框，內容填滿整張圖（full bleed） |
| 格式 | ⚠ 未確認，官方圖片規格頁沒寫，上傳時看後台的提示 |

`docs/images/` 裡現有的圖片都不符合尺寸（1280×780、1280×760、1100×560、1100×760、320×330、320×356），要重拍。

### 建議拍的 5 張

1. **編輯器**：左邊步驟列表、中間有紅框的截圖、下面是說明文字。這張最能說明產品，放第一張。
2. **錄製中**：網頁上有紅框，右下角是錄製控制列。
3. **圖片編輯**：畫面上有文字、箭頭、編號和遮罩。
4. **匯出**：打開匯出選單，看得到 PDF、HTML、Markdown、圖片四種格式。
5. **彈出視窗**：在一般網頁上方打開彈出視窗，看得到兩種錄製模式。

拍攝時用沒有個人資料的示範網站或測試帳號，畫面上不要出現真實的帳號、信箱或客戶資料。

### 怎麼拍出剛好 1280×800

- **編輯器、專案庫這類分頁**：開 Chrome DevTools，打開裝置工具列（Device toolbar），選「Responsive」，寬高設成 1280×800，**裝置像素比（DPR）設成 1**，再從裝置工具列右邊的選單選「Capture screenshot」。Mac Retina 螢幕的 DPR 預設是 2，不改的話會拍出 2560×1600。
- **彈出視窗、錄製中畫面**：彈出視窗是獨立視窗，裝置工具列拍不到。先用 macOS 截圖（⌘⇧4）拍下整個瀏覽器畫面，再用「預覽程式」的「工具 → 調整大小」與裁切，做成 1280×800（16:10）。
- 拍完用 `sips -g pixelWidth -g pixelHeight 檔名.png` 確認尺寸。

## 宣傳圖

| 圖 | 尺寸 | 必填 | 格式 |
| --- | --- | --- | --- |
| 小型宣傳圖（Small promo tile） | 440×280 | **必填** | PNG 或 JPEG |
| 大型宣傳圖（Marquee） | 1400×560 | 選填；沒有它就不會被選進首頁輪播 | PNG 或 JPEG |

官方的設計建議：

- 避免放文字。
- 縮小到一半仍然看得清楚。
- 填滿整個區域，不要留邊。
- 避免大量白色或淺灰色，否則在商店的淺色背景上會糊成一片。

建議做法：用品牌主色當底，把 Stepmark 的圖示放大置中，或放一張簡化的編輯器畫面。不要寫標語。

## 影片與網址

| 欄位 | 建議填寫 | 說明 |
| --- | --- | --- |
| YouTube 影片 | 選填 | 展示擴充功能的功能 |
| Homepage URL | `https://github.com/Yizhe0407/Stepmark` | repo 是公開的，2026-10-18 確認可開啟 |
| Support URL | `https://github.com/Yizhe0407/Stepmark/issues` | 選填 |
| Official URL | 不填 | 只能選已驗證屬於你的網站，目前沒有 |

注意：首頁目前的 `README.md` 是中文，還寫著「目前還沒有上架到瀏覽器商店」以及自行建置的步驟。上架後要改成商店安裝連結。

## 來源

- 後台 Store listing 欄位（說明、宣傳圖、影片、網址）：<https://developer.chrome.com/docs/webstore/cws-dashboard-listing>（2020-12-07）
- 商店頁最佳做法（名稱、說明格式）：<https://developer.chrome.com/docs/webstore/best-listing>（2024-08-02）
- 圖片規格（圖示、截圖、宣傳圖）：<https://developer.chrome.com/docs/webstore/images>（2018-06-11）
- 摘要 132 字元上限：<https://developer.chrome.com/docs/webstore/prepare>（2023-10-16）
- 關鍵字堆砌與資料缺漏的規定：<https://developer.chrome.com/docs/webstore/program-policies/policies>（2025-05-22）
- 違規代碼：<https://developer.chrome.com/docs/webstore/troubleshooting>（2026-07-20）
- Limited Use 政策：<https://developer.chrome.com/docs/webstore/program-policies/limited-use>（2022-11-01）
- 2023 年改版新增分類：<https://blog.google/products/chrome/google-chrome-web-store-redesign/>
