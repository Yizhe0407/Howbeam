# 打包與上傳

## 送審前要改的程式

| 項目 | 位置 | 為什麼 |
| --- | --- | --- |
| 移除 `console.log('[howbeam] recorder ready on', location.href)` | `extension/entrypoints/content.ts:325` | 會把使用者正在錄製的網址印到那個網頁的 console，網頁本身的程式也讀得到。這是全專案唯一一個 `console.log`。 |
| 確認版本號 | `extension/package.json` 的 `version`（目前是 `0.1.0`） | manifest 的版本號從這裡產生。第一次上架用 `0.1.0` 可以；之後每次上傳都必須比上一次大。 |

## 打包

在 `extension/` 資料夾執行：

```bash
pnpm install
pnpm validate   # 型別檢查、lint、測試、Chrome 與 Firefox 建置，全部通過才繼續
pnpm zip        # 產生要上傳的 ZIP
```

產生的檔案（版本號會跟著 `package.json` 變）：

```text
extension/.output/howbeam-extension-0.1.0-chrome.zip
```

2026-10-18 實測：ZIP 約 2.79 MB，`manifest.json` 在 ZIP 根目錄，符合官方要求。

**只上傳這個 ZIP。** 不要上傳 `extension/.output/e2e-chrome-mv3`：那是自動化測試用的版本，多了 `clipboardRead` 權限，還預先授權所有網站。

### 上傳前自己試一次

1. 把 ZIP 解壓縮到一個新資料夾。
2. 到 `chrome://extensions` 按「載入未封裝項目」，選這個資料夾。
3. 錄一份專案、編輯、匯出一次，確認正常。
4. 試完移除這個測試用的擴充功能，避免和平常開發用的版本混在一起。

## 上傳規則

- 在 Developer Dashboard 按「Add new item」，選 ZIP 上傳。manifest 和 ZIP 都有效，才會進入下一頁開始編輯。
- 套件大小上限是 2 GB。
- `manifest.json` 必須在 ZIP 根目錄，不能放在子資料夾裡。
- 上傳後無法在後台修改 manifest。要改任何內容，都得提高版本號、重新打包、重新上傳。
- manifest 裡有註解時，常會出現「Cannot parse the manifest」錯誤。WXT 產生的 manifest 沒有註解，實測確認過。
- 第一次建立項目時，Package 分頁不能編輯。

## manifest 內容（2026-10-18 打包結果）

送審時審核員看到的權限就是這些，[privacy-practices.md](privacy-practices.md) 裡每一項都有用途說明：

| 欄位 | 值 |
| --- | --- |
| `permissions` | `storage`、`unlimitedStorage`、`activeTab`、`scripting`、`downloads`、`clipboardWrite` |
| `optional_host_permissions` | `<all_urls>`（執行時才請求） |
| `web_accessible_resources` | `snapshot-shield.html`，對象是 `<all_urls>` |
| `content_scripts` | 空的，錄製時才注入 |
| `minimum_chrome_version` | `111` |

## 來源

- 上傳與後台分頁：<https://developer.chrome.com/docs/webstore/publish>
- 打包規則：<https://developer.chrome.com/docs/webstore/prepare>（2023-10-16）
