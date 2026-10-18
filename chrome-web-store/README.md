# Chrome 線上應用程式商店上架資料

這個資料夾放 Stepmark 送審 Chrome 線上應用程式商店（Chrome Web Store）需要的所有文字、規格與流程。目前只上架 Chrome，Firefox 暫不處理。

所有規定都在 2026-10-18 對照 developer.chrome.com 與 blog.chromium.org 的官方頁面查證，每個檔案最後都附上來源網址。標示 **⚠ 未確認** 的項目，是官方文件沒有寫明、只能在後台實際畫面確認的部分，填寫時以後台為準，不要照本文件猜。部分來源是透過網頁摘要工具讀取的，正式引用原文前，請點連結核對一次。

## 檔案

| 檔案 | 內容 | 用在哪裡 |
| --- | --- | --- |
| [account.md](account.md) | 開發者帳號註冊、兩步驟驗證、商家身分聲明 | 第一次註冊 |
| [package.md](package.md) | 送審前要改的程式、打包指令、上傳規則 | 後台「Package」分頁 |
| [listing.md](listing.md) | 商店頁文字（中英）、分類、圖示、截圖與宣傳圖規格 | 後台「Store listing」分頁 |
| [privacy-practices.md](privacy-practices.md) | 單一用途說明、每個權限的用途說明、資料使用申報 | 後台「Privacy」分頁 |
| [privacy-policy.md](privacy-policy.md) | 隱私權政策全文（中英），它的 GitHub 網址就是政策連結 | 後台「Privacy」分頁的政策網址 |
| [submit-and-review.md](submit-and-review.md) | 發布設定、給審核員的測試說明、送審、退件與更新 | 「Distribution」「Test instructions」分頁與送審之後 |

## 完整流程

照順序做，每一步完成就打勾。

### 一、送審前準備

- [ ] 改掉程式裡會被審核或使用者看到的問題，見 [package.md](package.md) 的「送審前要改的程式」。
- [ ] 自己完整使用 3 到 5 天，走過錄製、編輯、匯出和自動備份。`extension/tests/README.md` 裡列在手動驗收清單的流程（視覺編輯、補拍、隱私遮罩）要逐項確認。
- [ ] 把 [privacy-policy.md](privacy-policy.md) 推到 main，確認網址打得開：
  `https://github.com/Yizhe0407/Stepmark/blob/main/chrome-web-store/privacy-policy.md`
  上架後**不要搬動或改名這個檔案**，否則商店上的政策連結會失效。

### 二、開發者帳號

- [ ] 照 [account.md](account.md) 開啟兩步驟驗證、註冊並繳一次性的 5 美元註冊費、驗證聯絡信箱、填發布者名稱。
- [ ] 決定要聲明為商家（Trader）還是非商家（Non-Trader）。這需要你自己判斷，見 [account.md](account.md)。

### 三、準備圖片

- [ ] 拍 1 到 5 張 1280×800 的截圖，見 [listing.md](listing.md)。
- [ ] 做一張 440×280 的小型宣傳圖（必填）。
- [ ] （選填）做一張 1400×560 的大型宣傳圖。

### 四、打包與上傳

- [ ] 在 `extension/` 執行 `pnpm validate`，全部通過。
- [ ] 執行 `pnpm zip`，取得 `extension/.output/stepmark-extension-<版本>-chrome.zip`。
- [ ] 解壓縮後用「載入未封裝項目」實際試一次，確認就是要送審的版本。
- [ ] 在 Developer Dashboard 按「Add new item」上傳 ZIP。

### 五、填寫後台

- [ ] Store listing：照 [listing.md](listing.md) 填。
- [ ] Privacy：照 [privacy-practices.md](privacy-practices.md) 填。
- [ ] Distribution：照 [submit-and-review.md](submit-and-review.md) 選。
- [ ] Test instructions：貼上 [submit-and-review.md](submit-and-review.md) 的測試說明。

### 六、送審與上架

- [ ] 按「Submit for review」。要自己決定上架時間的話，取消勾選「審核通過後立即發布」。
- [ ] 審核通過後 30 天內按發布，否則會退回草稿，需要重新送審。
- [ ] 上架後更新根目錄的 `README.md`：拿掉「目前還沒有上架到瀏覽器商店」，改成商店連結。

## 對使用者的承諾

隱私權政策寫了以下幾件事，之後改程式時都要遵守。只要違反其中一項，就得先改政策並告知使用者：

- 不把任何資料傳到網路上。
- 不使用分析、廣告或第三方服務。
- 資料處理方式改變時，先更新政策，並在擴充功能裡告知。

## 尚未確認的項目

| 項目 | 怎麼確認 |
| --- | --- |
| 商店分類的完整清單 | 後台 Store listing 的分類下拉選單 |
| Privacy 分頁資料類別勾選框的確切名稱 | 後台 Privacy 分頁 |
| Privacy 分頁三項保證聲明的原文 | 後台 Privacy 分頁 |
| 截圖接受的檔案格式 | 上傳截圖時後台的提示 |
| 選用的 host 權限（`optional_host_permissions`）會不會拉長審核時間 | 官方只說廣泛 host 權限會拉長，沒提到選用權限 |
