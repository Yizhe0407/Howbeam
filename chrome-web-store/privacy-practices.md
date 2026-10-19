# 隱私申報（Privacy 分頁）

Privacy 分頁要填四件事：單一用途、每個權限的用途、是否使用遠端程式碼、資料使用申報與隱私權政策網址。

審核員看英文，所以下面要貼的內容都用英文寫，並附上中文翻譯方便核對。

## 1. 單一用途（Single purpose description）

官方規定擴充功能必須有一個範圍明確、容易理解的單一用途，與這個用途無關的權限會被視為多做了其他事。

**貼上：**

```text
Howbeam records the clicks a user makes on a web page and turns them into a step-by-step guide with screenshots and annotations, which the user can edit and export. Every feature (recording, editing, export and backup to a local folder) serves creating these guides.
```

> 中文：Howbeam 記錄使用者在網頁上的點擊，轉成附截圖與標註的逐步教學，讓使用者編輯並匯出。所有功能（錄製、編輯、匯出、備份到本機資料夾）都是為了製作這些教學。

## 2. 權限用途說明（Permission justification）

官方要求「only the narrowest permissions necessary」：只能要求必要的最小權限。如果要求了權限卻沒用到，或不是功能需要的，會被退件（違規代碼 Purple Potassium）。下面每一項都對照過程式碼，確認真的有用到。

### storage

```text
Saves the user's settings (interface language and recording preferences) and the state of a recording in progress, so a recording survives the background service worker being restarted.
```

> 中文：儲存使用者設定（介面語言、錄製偏好），以及正在進行中的錄製狀態，讓背景 service worker 重新啟動時錄製不會中斷。

### unlimitedStorage

```text
Projects are stored only on the user's device, in IndexedDB, and each step contains a full-resolution screenshot. A guide with many steps easily exceeds the default storage quota. Nothing is sent to a server, so local storage is the only place projects can be kept.
```

> 中文：專案只存在使用者的裝置上（IndexedDB），每個步驟都含一張原尺寸截圖，步驟一多就很容易超過預設儲存上限。資料不會傳到伺服器，本機是唯一能存放專案的地方。

程式位置：`extension/lib/storage/`

### activeTab

```text
When the user clicks the toolbar button and starts recording, Howbeam needs temporary access to that tab to inject the recorder and to take screenshots of it with tabs.captureVisibleTab. Without the optional host permission, recording is limited to this tab.
```

> 中文：使用者點工具列按鈕並開始錄製時，Howbeam 需要暫時存取這個分頁，才能注入錄製程式並用 `tabs.captureVisibleTab` 截圖。沒有授權選用的 host 權限時，只能錄製這一個分頁。

程式位置：`extension/entrypoints/background.ts:61`

### scripting

```text
Injects Howbeam's own bundled recorder script and its highlight styles into the tab the user chose to record (scripting.executeScript and scripting.insertCSS), and removes them when the recording ends. No remote code is executed.
```

> 中文：把 Howbeam 自帶的錄製程式與標示樣式注入使用者選擇錄製的分頁（`scripting.executeScript`、`scripting.insertCSS`），錄製結束時移除。不會執行任何遠端程式碼。

程式位置：`extension/lib/recording/recorder-injection.ts`、`extension/lib/recording/background/capture-flow.ts:209-215`

### downloads

```text
Saves the exports the user asks for (PDF, single HTML file, Markdown ZIP, annotated images ZIP, and .howbeam project files) to the user's computer with downloads.download.
```

> 中文：用 `downloads.download` 把使用者要求的匯出檔（PDF、單一 HTML 檔、Markdown ZIP、標註圖片 ZIP、`.howbeam` 專案檔）存到使用者的電腦。

程式位置：`extension/lib/export/download-utils.ts:68`

### clipboardWrite

```text
The "copy image" action in the editor writes the annotated image of a step to the clipboard as a PNG, so the user can paste it into another app.
```

> 中文：編輯器的「複製圖片」會把某個步驟的標註圖片以 PNG 寫入剪貼簿，讓使用者貼到其他應用程式。

程式位置：`extension/components/editor/StepActions.tsx`

### Host permission：`<all_urls>`（選用，optional_host_permissions）

```text
This is an optional permission. It is requested at runtime only when the user starts a Steps recording, and the user can decline. It lets the recording continue when the user switches to another tab or navigates to another site during the recording, because a guide often spans several pages. If the user declines, Howbeam records only the current tab through activeTab. Howbeam injects its recorder only into tabs that are part of a recording the user started; it does not read or modify any other page.
```

> 中文：這是選用權限，只在使用者開始「步驟」錄製時才請求，使用者可以拒絕。一份教學常常會跨好幾個頁面，有了這個權限，使用者在錄製中切換分頁或跳到其他網站時才能繼續錄製。拒絕的話，Howbeam 只透過 activeTab 錄製目前分頁。Howbeam 只把錄製程式注入使用者自己開始錄製的分頁，不會讀取或修改其他任何頁面。

程式位置：`extension/components/popup/RecordControls.tsx:149`（請求權限）、`extension/lib/recording/background/follow-mode.ts`（跨分頁錄製）

### 審核員可能會問：`web_accessible_resources`

這不是權限，Privacy 分頁沒有欄位要填，但 manifest 對所有網站開放了 `snapshot-shield.html`。如果審核員問起，可以這樣回答：

```text
snapshot-shield.html is an extension page that Howbeam shows in an iframe over the recorded page while a screenshot is being prepared, so the page cannot change during capture. It must be web-accessible to be framed on the recorded page. It does nothing on its own: it only acts after it receives a one-time token that the extension stores for the current recording.
```

> 中文：`snapshot-shield.html` 是 Howbeam 在準備截圖時，以 iframe 蓋在被錄製頁面上的擴充功能頁面，避免截圖期間頁面變動。它必須可被網頁存取，才能嵌入被錄製的頁面。它本身不會做任何事，只有在拿到擴充功能為這次錄製存下的一次性憑證後才會動作。

依據：`extension/wxt.config.ts:44-48` 的註解。

## 3. 遠端程式碼（Remote code）

**選：No, I am not using remote code.**

依據：2026-10-18 檢查打包結果，裡面沒有 `eval(`、`new Function(`，也沒有載入外部腳本。唯一的 `fetch(` 是把本機的 `data:` 網址轉成 Blob（`extension/lib/recording/background/recorder-runtime.ts:41`），不會連網。官方要求擴充功能的完整功能必須能從送審的程式碼看出來，Howbeam 符合。

## 4. 資料使用申報（Data usage）

### Howbeam 實際處理的資料

錄製時，被點擊的頁面會送出以下資料（`extension/lib/recording/content/capture-sender.ts`），連同截圖一起存進本機的 IndexedDB：

| 資料 | 內容 |
| --- | --- |
| 截圖 | 目前分頁可見範圍的畫面，頁面上看得到的內容都會被拍到 |
| 網址 | 被錄製頁面的 `location.href` |
| 元素文字 | 被點擊元素上看得到的文字，或它的 label、placeholder、aria-label（`extension/lib/capture/element-description.ts`）。**不會讀取輸入框裡使用者打的值**，但如果那些字顯示在畫面上，截圖會拍到。 |
| 位置與時間 | 元素在畫面上的位置、視窗大小與捲動位置、時間戳記 |
| 使用者自己編輯的內容 | 說明文字、標註、專案名稱、標籤 |
| 設定 | 介面語言、錄製偏好、備份資料夾的存取權 |

這些資料都不會離開使用者的電腦。只有使用者自己按匯出、或開啟自動備份時，才會把檔案寫到使用者選的位置。

### 要不要勾選資料類別

官方規定如下：

- User Data FAQ 回答「資料只存在本機也需要隱私權政策嗎？」的答案是「Yes」，揭露義務也適用於只在本機處理或儲存的資料。
- 2026-08-01 起執行的新規定：所有資料收集都必須明顯揭露，不論是否和單一用途密切相關。

**建議勾選以下三類**（後台實際名稱 ⚠ 未確認，請找意思相符的勾選框）：

| 類別（第三方報導的名稱） | 對應 Howbeam 的資料 |
| --- | --- |
| Website content | 截圖、被點擊元素的文字 |
| Web history | 被錄製頁面的網址 |
| User activity | 使用者在頁面上的點擊 |

這是建議，不是官方明文要求，理由是：

- 官方明訂「沒揭露」會被退件：違規代碼 Purple Lithium 是處理資料卻沒有隱私權政策；Purple Nickel 是沒有明顯揭露或沒取得同意。
- 「申報後資料只存在本機」沒有任何違規代碼。

**不要勾選**：個人識別資訊、健康資訊、財務與付款資訊、驗證資訊、個人通訊、位置。Howbeam 不會刻意收集這些資料。

**風險提醒**：使用者錄製的頁面如果剛好顯示這些資訊，截圖還是會拍到。這一點已經寫在隱私權政策裡。

### 三項保證聲明（Certifications）

後台會要求勾選三項聲明，保證你遵守揭露內容，其中一項是遵守 Limited Use 政策。

⚠ 三項的原文未確認。官方頁面只用截圖呈現，沒有文字。

勾選前逐項讀一遍。Howbeam 不傳送、不出售、不分享任何資料，應該三項都符合。如果某一項的內容和 Howbeam 的實際做法對不上，先停下來不要勾，回來確認。

### 隱私權政策網址

```text
https://github.com/Yizhe0407/Stepmark/blob/main/chrome-web-store/privacy-policy.md
```

官方要求隱私權政策說明資料如何收集、使用、分享，以及會分享給哪些對象，並填在後台指定的欄位。政策全文見 [privacy-policy.md](privacy-policy.md)。

## 安裝後的揭露

官方要求明顯告知會收集哪些資料、如何使用，並取得使用者明確同意。Howbeam 目前的做法：

- 商店頁說明的「Privacy」段落（見 [listing.md](listing.md)）。
- 安裝後自動開啟的歡迎頁有「隱私與權限」區塊：「所有截圖只儲存在這台電腦，不會上傳」、「預設只錄製目前分頁；若要跨分頁錄製，首次開始時會請你授權」。
- 跨分頁錄製的權限，由使用者在瀏覽器的權限對話框裡明確同意。

## 來源

- Privacy 分頁欄位：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>（2020-06-12）
- 權限使用政策：<https://developer.chrome.com/docs/webstore/program-policies/permissions>（2022-11-01）
- 單一用途：<https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq>（2024-07-10）
- 隱私權政策要求：<https://developer.chrome.com/docs/webstore/program-policies/privacy>（2022-11-01）
- User Data FAQ（本機儲存也要政策）：<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- Limited Use：<https://developer.chrome.com/docs/webstore/program-policies/limited-use>（2022-11-01）
- 揭露要求：<https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements>（2022-11-01）
- 遠端程式碼：<https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>（2024-04-03）
- 違規代碼：<https://developer.chrome.com/docs/webstore/troubleshooting>（2026-07-20）
- 2026 年政策更新（2026-08-01 起執行）：<https://developer.chrome.com/blog/cws-policy-updates-2026>（2026-07-01）
