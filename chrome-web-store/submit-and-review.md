# 發布設定、送審與審核

## Distribution 分頁

### 付費

選免費。⚠ 定價欄位的確切選項未確認，官方 Distribution 說明頁沒寫，以後台畫面為準。

### 可見度（Visibility）

| 選項 | 誰能安裝 |
| --- | --- |
| Public | 所有人，會出現在商店搜尋結果裡 |
| Unlisted | 不會出現在商店裡，但拿到網址的人都能安裝 |
| Private | 只有你指定的人：帳號設定裡的受信任測試者（trusted testers），或你加入的 Google 群組成員 |

**不論選哪一種，審核標準都一樣。**

建議第一次先選 **Unlisted**，把網址給少數人試用，沒問題再改成 Public。

### 地區

選 All regions，或逐一勾選國家。

## Test instructions 分頁

官方說明：需要時提供測試說明與測試帳號。Howbeam 不用登入，但錄製流程不容易自己摸索，所以建議提供說明。

**貼上：**

```text
No account or login is needed. All data stays in the browser.

1. Open any regular website (for example https://example.com). Recording is not possible on chrome:// pages or the Chrome Web Store.
2. Click the Howbeam toolbar icon, keep "Steps" selected and click "Start recording". Chrome may ask for access to all sites; this is optional and only lets recording follow you to other tabs. You can decline and keep testing in the current tab.
3. Click a few links or buttons on the page. Each click is captured as a step with a screenshot and a red highlight. Use the control bar in the bottom-right corner to finish.
4. The editor opens with the recorded steps. You can edit descriptions, open "Edit image" to add annotations, and use "Export" to download a PDF, HTML, Markdown or images.
5. The library (from the popup) lists all projects. Settings (gear icon) has automatic backup to a local folder.
```

> 中文：不需要帳號，資料都留在瀏覽器裡。① 打開一般網站；② 點工具列圖示，選「步驟」並開始錄製，Chrome 可能會詢問是否允許存取所有網站，這是選用權限，可以拒絕；③ 點幾個連結或按鈕，用右下角控制列的「完成」結束；④ 編輯器會打開，可以改說明、編輯圖片、匯出；⑤ 專案庫列出所有專案，設定裡有自動備份。

## 送審

1. 四個分頁都填完後，按 **Submit for review**，在對話框確認送出。
2. **延後發布（deferred publishing）**：送出前在確認對話框取消勾選，審核通過後就不會自動上架，由你決定時間。
   - 審核通過後，**30 天內**要按發布。
   - 超過 30 天會退回草稿，必須重新送審。
   - 送出後也可以從選單選「Defer publish」。

## 審核時間

- 官方說法：「For most extensions, review is completed within a few days, but it can take up to a few weeks.」大部分幾天內完成，最長可能要幾週。
- 會拉長審核時間的情況：新開發者、新擴充功能、程式大幅變更、要求廣泛的 host 權限或敏感的執行權限。
- Howbeam 是新開發者的新擴充功能，要預期審核會比較久。
- ⚠ 未確認：`<all_urls>` 只放在選用權限（`optional_host_permissions`）時，會不會也被當成廣泛的 host 權限而拉長審核。官方頁面沒有說明。

## 被退件時

1. 退件信會寫出違反哪一條政策，以及怎麼申訴。已上架的版本不受影響。
2. 對照下面的違規代碼找原因，修正後提高版本號、重新打包、重新送審。
3. 如果認為審核有誤，可以申訴。2026-04-08 起，申訴改在 Developer Dashboard 裡進行：
   - 在項目頁或發布者帳號頁送出申訴。
   - 表單會自動帶入擴充功能 ID 與違規內容，後續透過 email 聯絡。
   - 同一件事已經有申訴在處理時，不能再送一次。

### 和 Howbeam 最相關的違規代碼

| 代碼 | 原因 | 對應文件 |
| --- | --- | --- |
| Purple Lithium | 處理使用者資料卻沒有隱私權政策 | [privacy-practices.md](privacy-practices.md) |
| Purple Nickel | 沒有明顯揭露資料用途，或沒取得同意 | [privacy-practices.md](privacy-practices.md) |
| Purple Potassium | 要求了沒用到或功能不需要的權限 | [privacy-practices.md](privacy-practices.md) |
| Yellow Zinc | 缺少說明、圖示或截圖 | [listing.md](listing.md) |
| Yellow Argon | 關鍵字堆砌 | [listing.md](listing.md) |
| Yellow Potassium | 沒有提供明確的價值或用途 | [listing.md](listing.md) |

## 更新版本

1. 提高 `extension/package.json` 的 `version`。
2. 執行 `pnpm validate`、`pnpm zip`。
3. 在後台 Package 分頁上傳新的 ZIP，送審。
4. 更新同樣要經過審核，時間取決於變更內容與幅度；審核期間，線上版本照常運作。
5. 依比例逐步推出（percentage rollout）只開放給 7 天活躍使用者超過 10,000 人的擴充功能，剛上架用不到。
6. 如果新版本改變了資料處理方式，先更新 [privacy-policy.md](privacy-policy.md) 與後台的 Privacy 分頁，再送審。2026-08-01 起，安裝後資料處理方式有改變時，必須主動告知使用者。

## 上架之後

- [ ] 根目錄 `README.md`：拿掉「目前還沒有上架到瀏覽器商店」，加上商店連結；自行建置的段落改放到「給開發者」。
- [ ] 確認隱私權政策網址仍然打得開。
- [ ] 定期查看 GitHub Issues，也就是商店頁的 Support URL。

## 來源

- Distribution 分頁：<https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>（2020-12-07）
- 發布流程、Test instructions、延後發布：<https://developer.chrome.com/docs/webstore/publish>
- 審核流程：<https://developer.chrome.com/docs/webstore/review-process>（2021-12-10）
- 申訴：<https://developer.chrome.com/blog/cws-new-appeals-process>（2026-04-08）
- 更新與依比例推出：<https://developer.chrome.com/docs/webstore/update>（2020-12-03）
- 違規代碼：<https://developer.chrome.com/docs/webstore/troubleshooting>（2026-07-20）
- 2026 年政策更新：<https://developer.chrome.com/blog/cws-policy-updates-2026>（2026-07-01）
- 私下發布給外部組織（2026-02-20 新增）：<https://developer.chrome.com/docs/extensions/whats-new>
