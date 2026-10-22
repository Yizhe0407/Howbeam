# Howbeam 擴充功能

這個目錄包含 Howbeam 的 WXT + React 瀏覽器擴充功能。安裝與使用請見 [專案 README](../README.md)。

## 環境

- Node.js
- pnpm

## 開發

```bash
pnpm install
pnpm dev
```

Chrome 開發輸出位於 `.output/chrome-mv3-dev`。在 `chrome://extensions` 啟用開發人員模式後，以「載入未封裝項目」載入該目錄。

Firefox 開發模式：

```bash
pnpm dev:firefox
```

## 本機 UX 與資料安全

- 專案庫可管理多份 Project；Editor 只讀取 URL 指定 Project，不會追隨或顯示其他全域錄製內容。
- 單筆步驟、章節與 Undo 使用 `contentRevision` CAS；完整 StepEntry／Snapshot group 於單一 IndexedDB transaction 更新。
- 發佈支援 PDF、Markdown ZIP（`.md` + 圖片）、自包含 HTML 與圖片 ZIP，公開圖片統一走遮罩 fail-closed compositor。
- `.howbeam` 是 ZIP（格式版本 4）：截圖以原始位元組存放、內容相同者依 SHA-256 只存一份；包含原始未遮罩圖，不應當作公開輸出。匯入只接受此格式。
- HTML 與 PDF 排成單色正式文件（含章節標題與步驟編號）。
- 錄製、編輯、發佈與縮圖 lazy mounting 全部在本機執行，不需要網路或後端。

## 原始碼分類

- `components/editor/`：Editor 畫面與編輯工作流元件。
- `components/popup/`：Popup 專用的錄製與匯出元件。
- `components/shared/`：跨入口共用元件；`components/ui/` 保留無領域狀態的 UI primitives。
- `lib/capture/`：DOM 候選、座標、frame probe 與擷取流程。
- `lib/editor/`、`lib/export/`、`lib/project/`：各功能領域的純邏輯與 hooks。
- `lib/media/`：annotation layout、圖片標註、裁切與 screenshot 工具。
- `lib/recording/`、`lib/runtime/`：錄製生命週期、queue、frame targeting、注入頁面與 snapshot shield 使用的錄製 UI（`recording-toolbar*.tsx` 等），以及瀏覽器訊息／導覽邊界。
- `lib/backup/`：自動備份到使用者選擇的資料夾（File System Access API 目錄 handle、排程與寫入）。
- `lib/storage/`：`models.ts` 定義持久化模型，`database.ts` 管理 schema 與 transaction 基礎，`*-repository.ts` 與 `project-structure.ts` 承擔各類讀寫；`storage.ts` 與 `persistence-limits.ts` 分別處理 extension storage 和容量限制。
- `lib/shared/`：僅放真正無領域狀態的工具。

新增檔案時應優先放入最接近的功能領域，內部程式碼與測試 mock 也應直接 import 具體責任模組，以免隱藏依賴方向、形成循環引用，或讓單一聚合 mock 意外攔截不相關行為。

## 驗證

```bash
pnpm test
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm lint
pnpm validate
pnpm validate:architecture
pnpm benchmark:detection
pnpm build
pnpm build:firefox
```

- `pnpm test:unit`：執行目前的 unit 測試檔。
- `pnpm test:integration`：執行目前的 integration 測試檔。
- `pnpm test`：執行目前設定的 Vitest unit/integration 測試套件。
- `pnpm test:e2e`：建立 Chrome MV3 production 版本並執行目前設定的 Playwright Chromium E2E 測試套件。
- `pnpm test:all`：依序執行 Vitest 與 Chromium E2E。
- `pnpm compile`：執行 TypeScript `tsc --noEmit`。
- `pnpm lint`：以 ESLint（`--max-warnings 0`）檢查整個原始碼樹；CI 在 compile 後也會執行。
- `pnpm validate`：依序執行型別、ESLint、架構、完整 Vitest、Chrome／Firefox production build、產物與 Firefox lint 檢查。
- `pnpm validate:architecture`：檢查 alias import cycle 與 `shared`、`ui`、storage model 的依賴邊界；CI 在 compile 後也會執行這個檢查。
- `pnpm benchmark:detection`：在真實 Chromium 與 production extension build 上執行 element-target accuracy、hover latency、capture bounds 與 replay exactly-once benchmark；詳細指標與 baseline 流程見 [tests/README.md](./tests/README.md)。
- `pnpm build`：建立 Chrome MV3 production 版本到 `.output/chrome-mv3`。
- `pnpm build:firefox`：建立 Firefox MV2 production 版本到 `.output/firefox-mv2`。


## 模組結構

- `.howbeam` archive 拆為 `lib/export/project-archive-contract.ts`、`-validation.ts`、`-serialize.ts` 與 `-import.ts`，沒有聚合入口；使用端直接 import 需要的模組。
- `lib/export/pdf/` 是 PDF 匯出：`pdf-layout.ts` 只負責排版並輸出頁面區塊資料（標題、段落、清單、圖片、裝飾），`pdf-render.ts` 用 PDFKit 把區塊畫成 tagged PDF（結構樹、圖片替代文字、書籤），`pdf-spec.ts` 是版面規格，`pdf-fonts.ts` 載入內建字型（建置方式見 [scripts/pdf-fonts/README.md](./scripts/pdf-fonts/README.md)）。
- `lib/export/text-wrap.ts` 依量測寬度換行（含中日文禁則），PDF 用實際字型量測，HTML 用估計字寬決定分欄。
- `lib/export/annotation-columns.ts` 決定標記清單分幾欄，PDF 與 HTML 共用同一規則：多一欄要讓清單至少矮兩行，每欄至少兩項，欄內最多折兩行；更長的項目橫跨整寬，前後的項目各自分欄。
- `lib/media/annotation-layout.ts` 是 annotation layout facade；純幾何、badge/callout collision placement、常數與型別分別位於相鄰的 `annotation-*.ts` 模組。
- `lib/editor/use-editor-entry-workspace.ts` 封裝 Editor 的完整項目列表、單一目前項目與 view state；儲存、permission 與 undo transaction 仍由 `editor/App.tsx` 協調。
- `lib/editor/use-editor-project-data.ts` 是 Editor 唯一的專案資料來源：開啟時讀一次；之後收到任何寫入的變更廣播，先讀專案列比對 revision，有變才重讀結構；本頁寫入直接採用 transaction 回傳的結構，畫面只依 revision 前進。`lib/editor/use-serial-operations.ts` 讓 Editor 的資料操作依序排隊執行，不會拒絕點擊。
- `lib/recording/background/recorder-runtime.ts` 提供 background state machine 使用的瀏覽器 capture/injection adapter，讓 retry 與 image scale 判定可獨立測試與重用。

## 字型

- UI 使用 Huninn（`public/fonts/Huninn-Regular.woff2`，OFL，授權文字在同一目錄）。
- PDF 匯出使用 Howbeam Sans TC，由官方 Noto Sans TC 產出的子集（OFL）；來源、重新產生與授權說明見 [scripts/pdf-fonts/README.md](./scripts/pdf-fonts/README.md)。

## 封裝

```bash
pnpm zip
pnpm zip:firefox
```

擴充功能不需要啟動任何後端伺服器；錄製資料、圖片合成與 ZIP 匯出都在本機完成。
E2E 所需的 fixture server 由 Playwright 自動啟停，測試架構詳見 [tests/README.md](./tests/README.md)。
