# 開發者帳號

## 步驟

1. **準備 Google 帳號。** 這個帳號會成為擴充功能的擁有者，建議用一個長期會保留的帳號。
2. **開啟兩步驟驗證。** 官方規定所有開發者帳號在發布或更新擴充功能之前，都必須開啟兩步驟驗證（2-Step Verification）。到 Google 帳號的「安全性」頁面開啟。
3. **進入 Developer Dashboard 註冊。** 網址是 <https://chrome.google.com/webstore/devconsole>。先同意開發者協議與政策，再繳註冊費。
   - 註冊費是**一次性 5 美元**。註冊說明頁只寫「一次性註冊費」，金額出現在 2026-04-28 的官方部落格。
   - 建立帳號時必須提供開發者信箱。
4. **填寫帳號資料**（Dashboard 的 Account 頁）：
   - **Publisher name（必填）**：會顯示在商店頁的「Offered by:」後面，可以用 `Howbeam` 或你的名字。
   - **聯絡信箱驗證（必做）**：新帳號一定要驗證。按「Add email」，再點驗證信裡的連結。
   - **實體地址**：只有提供購買、付費功能或訂閱的項目才需要。Howbeam 免費，不用填。
5. **聲明商家身分（Trader / Non-Trader）。** 官方規定所有開發者都要聲明，見下一節。

## 商家（Trader）還是非商家（Non-Trader）

這是歐盟《數位服務法》（DSA）的要求，所有開發者都必須聲明。**官方不會替你判斷，原文是「Each publisher must make their own determination」**，所以這一項需要你自己決定，本文件不替你選。

| | 商家（Trader） | 非商家（Non-Trader） |
| --- | --- | --- |
| 要提供的資料 | 法定姓名、聯絡電話、地址 | 不需要額外資料 |
| 驗證 | 個人商家必須用簡訊驗證電話 | 無 |
| 公開程度 | 這些資料會**公開顯示在商店頁最下方** | 不顯示 |

判斷前請讀官方 FAQ 對「商家」的定義。如果你是用個人身分、不以營利為目的分享免費工具，請依 FAQ 的描述判斷自己符不符合商家的定義。

## 其他限制

- 新的發布者最多只能有兩個已發布的擴充功能。
- 2026-04-28 起，Dashboard 可以邀請成員，角色有 Viewer、Item manager、Editor、Admin。受邀成員不用繳費，自己建立新的發布者仍要繳 5 美元。
- ⚠ 未確認：除了商家驗證以外，有沒有其他身分驗證。官方頁面沒有提到。

## 來源

- 註冊：<https://developer.chrome.com/docs/webstore/register>（頁面標示更新日 2024-02-13）
- 帳號設定、發布者名稱、聯絡信箱驗證：<https://developer.chrome.com/docs/webstore/set-up-account>（2023-10-16）
- 兩步驟驗證：<https://developer.chrome.com/docs/webstore/program-policies/two-step-verification>（2022-11-01）
- 商家聲明 FAQ：<https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq>
- 註冊費金額與成員角色：<https://developer.chrome.com/blog/cws-role-expansion-developer-dashboard>（2026-04-28）
- 新發布者最多兩個擴充功能：<https://developer.chrome.com/docs/webstore/publish>
