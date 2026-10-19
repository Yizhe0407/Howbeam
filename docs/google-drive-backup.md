# 把備份存到 Google Drive

> 這是一份「規劃文件」，說明我們**之後**可以怎麼讓 Howbeam 直接把專案備份到使用者自己的 Google Drive。目前還沒有實作。
> 已經做好的是比較簡單的「選資料夾自動備份」，見最下面的[現在可以用的做法](#現在可以用的做法)。

## 一句話結論

**可以做，而且不需要通過 Google 的嚴格審核。** 但要先準備一個公開網站、一個 Google Cloud 專案，並且先把擴充功能上傳到 Chrome 開發人員後台（不用公開上架）。

---

## 為什麼需要備份？

Howbeam 的專案全部存在**使用者自己的瀏覽器裡**，沒有帳號、也沒有我們的伺服器。這很隱私，但代價是資料只有一份。

| 情況 | 資料會不會不見？ |
| --- | --- |
| 按「清除瀏覽資料」 | **不會**（Chrome 官方說擴充功能的資料不會被清掉） |
| 電腦空間不夠 | **不會**（Howbeam 已經宣告 `unlimitedStorage`，Chrome 不會自動清掉） |
| 解除安裝擴充功能 | **會**（至少 Firefox 官方文件明說會清掉；Chrome 沒有明確說，要當作會） |
| 換電腦、換瀏覽器設定檔 | **會**（資料不會跟著走） |
| 硬碟壞掉 | **會** |

所以真正的風險是「**換電腦、重裝、硬碟壞**」。要解決，資料就必須存在瀏覽器**以外**的地方。

---

## 這個功能長什麼樣子？

1. 使用者在「設定」頁按「連接 Google Drive」。
2. 跳出 Google 的授權視窗（跟你用 Google 登入其他網站一樣）。
3. 使用者按「允許」。
4. 之後 Howbeam 自動把專案存成 `.howbeam` 檔，放進使用者自己的 Drive。
5. 換電腦時，連上同一個 Google 帳號，就能把專案拉回來。

資料只在「使用者」和「Google」之間流動，**我們不經手、也不用付任何儲存費用**。

---

## 需要 Google 審核嗎？

**不需要敏感權限的審核。** Google 把 Drive 的權限分成三級：

| 等級 | 例子 | 能做什麼 | 審核 |
| --- | --- | --- | --- |
| 非敏感 | `drive.file`、`drive.appdata` | 只能碰「我們自己建立的檔案」 | **不需要嚴格審核** |
| 敏感 | — | — | 要審核 |
| 受限 | `drive`、`drive.readonly` | 看得到使用者所有檔案 | 要審核＋安全評估 |

我們只需要第一級，所以：

- 使用者**不會**看到「這個應用程式未經 Google 驗證」的嚇人警告。
- **沒有** 100 人上限。

**唯一的小代價**：沒做「品牌驗證」的話，授權畫面上不會顯示 Howbeam 的名稱和圖示（只是比較不顯眼，不影響使用）。品牌驗證是選配，Google 說自動驗證通常幾分鐘、需要人工時約 2–3 個工作天。

> ⚠️ Google 說過可能「重新調整某些權限的等級」。今天是非敏感，不保證永遠是。真的調整時會有緩衝期和通知信。

---

## 要先準備什麼？

這些需要**專案擁有者**（不是我）去做：

- [ ] **一個公開網站**：要有首頁（說明 Howbeam 是什麼）和「隱私權政策」頁面，兩者要在同一個網域。
- [ ] **隱私權政策**：要寫清楚 Howbeam 怎麼存取、使用、儲存 Google 資料（例如：只會把備份檔寫進你的 Drive，不會讀其他檔案）。
- [ ] **Google Cloud 專案**：註冊、設定「OAuth 同意畫面」、建立 OAuth 用戶端（類型選「Chrome Extension」）。免費。
- [ ] **Google Search Console 網域驗證**：證明這個網站是你的。
- [ ] **Chrome 開發人員帳號**：要把擴充功能先上傳到開發人員後台（**不用公開**），取得一個固定的「擴充功能 ID」。Chrome 要求授權用的 ID 不能變，否則每換一個資料夾載入就會失敗。有一次性的註冊費。

---

## 會遇到的限制

### 1. 要選「看得見的資料夾」，不要選「隱藏資料夾」

Google 提供兩種放法：

| | 隱藏資料夾（`drive.appdata`） | 看得見的資料夾（`drive.file`） |
| --- | --- | --- |
| 使用者看得到檔案嗎 | **看不到** | 看得到 |
| 使用者撤銷授權後 | **備份會跟著被刪** | 檔案還在 |
| 使用者手動刪除 | 可以整個資料夾一起刪 | 單獨刪檔案 |

Google 官方原文：「The application data folder is deleted when a user uninstalls your app from their My Drive.」意思是只要使用者到 Google 帳戶裡把 Howbeam 的存取權移除，備份就一起沒了。**備份最怕的就是這種悄悄消失**，所以我們建議用「看得見的資料夾」。

不過 `drive.file` 有個代價：重裝之後，Howbeam 只能存取「它自己建立的檔案」，所以要還原舊備份時，**需要使用者透過 Google 的檔案選擇視窗，自己選一次**。

### 2. Firefox 的做法不一樣

Chrome 和 Firefox 的登入機制不同。Firefox 要用另一套流程，並且要用本機位址當回呼網址。做得到，但要寫兩套。

### 3. 備份檔很大

專案含截圖，單一檔案可能很大。Google 對大檔案要用「分段上傳」，要多寫一段程式處理。

---

## 隱私要注意的事

- Howbeam 目前的承諾是「資料只存在你的電腦，不會上傳任何地方」。加了這個功能後，**要改成**「預設只存本機；你主動連接 Google Drive，才會上傳到你自己的 Drive」。README 和隱私權政策都要同步修改。
- `.howbeam` 備份檔含**沒有遮罩的原始截圖**。使用者如果在截圖裡有密碼、個資，這些會被上傳。設定頁要明確提醒。
- Google 要求所有用 Google API 的應用程式都遵守「API 服務使用者資料政策」，不管有沒有通過驗證。

---

## 建議的做法與順序

1. **先做**「選資料夾自動備份」（已完成）。不需要 Google、不需要審核、不需要網站。
2. **之後再做** Google Drive 直連，等上面「要先準備什麼」都準備好了再開始：
   1. 確認 Google Cloud 與 Chrome 開發人員後台設定好。
   2. 先做 Chrome 版（用 `drive.file`）。
   3. 做備份、還原、錯誤處理。
   4. Firefox 版另外做，或暫時只支援 Chrome。
   5. 更新 README、隱私權政策。

---

## 現在可以用的做法

**設定 → 自動備份 → 選擇備份資料夾。**

- 使用者選一個資料夾，Howbeam 就會自動把專案存成 `.howbeam` 檔放進去。
- 如果把這個資料夾放在電腦上的 Google Drive、Dropbox 或 OneDrive 同步資料夾裡，就**自然有雲端備份**，而且不需要 Google 審核。
- 瀏覽器重啟後可能需要點一下「重新授權」。
- 專案從 Howbeam 刪除後，備份檔會保留。
- 還原時，到專案庫按「匯入」選擇備份檔。
- 限制：Firefox 沒有選資料夾的功能，只能手動匯出。

---

## 名詞小辭典

| 名詞 | 白話意思 |
| --- | --- |
| OAuth | 「用 Google 帳號授權給某個程式」的標準流程，不用把密碼給程式 |
| 權限範圍（scope） | 使用者允許程式做什麼事的清單，例如「只能碰自己建立的檔案」 |
| 驗證／審核 | Google 檢查你的程式是不是正當、有沒有講清楚怎麼用資料 |
| 未驗證警告 | 沒通過驗證時，使用者會看到的紅色警告畫面 |
| 品牌驗證 | 讓授權畫面顯示你的名稱和標誌 |
| `.howbeam` 檔 | Howbeam 自己的專案檔，包含所有步驟、截圖、說明，可匯入還原 |

---

## 資料來源（Google 與 Chrome 官方文件）

- [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Store application-specific data](https://developers.google.com/workspace/drive/api/guides/appdata)
- [OAuth app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Submit for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
- [Unverified apps](https://support.google.com/cloud/answer/7454865)
- [When is verification not needed](https://support.google.com/cloud/answer/13464323)
- [OAuth 2.0: authenticate users with Google (Chrome Extensions)](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Storage and cookies (Chrome Extensions)](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [identity (MDN, Firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity)
