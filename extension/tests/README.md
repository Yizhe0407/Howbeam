# 測試架構

測試依照「實際跨越的系統邊界」分層，而不是依照被測檔案所在目錄分類：

```text
tests/
├── unit/                  # 純函式、幾何、狀態機與資料正規化
├── integration/           # IndexedDB、React、DOM overlay 與 browser API 邊界
├── benchmarks/            # production build 的 accuracy／latency regression corpus
└── e2e/
    ├── fixtures/
    │   ├── server.mjs     # 本機 HTTP fixture server
    │   └── site/          # 錄製目標頁、frame 與導覽頁
    ├── setup/
    │   └── global-setup.ts
    ├── specs/             # 使用者工作流
    └── support/           # Playwright fixtures、路徑與共用操作
```

## 分層規則

- `unit/`：不掛載 React、不開 IndexedDB、不啟動瀏覽器；輸入與輸出可完全由函式參數判定。
- `integration/`：驗證同一程序內的多模組合作，例如 fake IndexedDB、jsdom、React hooks、overlay 與 mock browser API。
- `e2e/`：載入未 mock 的 Chrome MV3 production build，驗證 background、content script、storage、真實截圖、popup、editor、Clipboard 與 Downloads API 的完整流程。
- 同一行為若可在較低層可靠證明，就放在較低層；只有跨 extension context、瀏覽器權限或使用者工作流才升到 E2E。

## 指令

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:all
pnpm benchmark:detection
```

`pnpm test` 會一次執行 unit 與 integration。`pnpm test:e2e` 會先建立 production extension，再由 Playwright 啟動 fixture server 與 Chromium。

## E2E 隔離

- 每項測試使用獨立的 Chromium profile，測試前清除 extension storage 與 IndexedDB。
- E2E 專用 extension 複本位於 `.output/e2e-chrome-mv3`；production manifest 不會被修改。
- E2E 複本預先授予 `<all_urls>`，避免權限提示干擾自動化；另只在該複本加入 `clipboardRead`，用來讀回並驗證 production UI 寫入的 PNG。
- 測試固定單 worker 執行，避免 `activeTab`、`captureVisibleTab` quota 與系統剪貼簿互相干擾。
- 失敗時保存 trace、頁面截圖與 console error；成功案例不保留大型 artifact。

E2E 與 Vitest 的測試檔及測試項目會隨功能持續增加，實際數量與結果請以當次測試命令輸出為準；視覺編輯、補拍與隱私遮罩的跨 context 實機流程仍列在手動／E2E 驗收清單。

## Element detection benchmark

`pnpm benchmark:detection` 會載入未 mock 的 Chrome MV3 production build，在真實 Chromium 中操作一個固定、production-style 的網站 corpus。Corpus 涵蓋 native／ARIA controls、delegated listeners、透明與 painted occluders、transform、clipping、inline fragments、SVG、canvas、image map、open／closed Shadow DOM，以及 same-origin／cross-origin iframe。

Benchmark 分三類量測：

- **Activation accuracy**：steps mode 的 hover target 是否符合使用者實際會啟動的 hit surface。
- **Annotation accuracy**：snapshot mode 是否選中畫面上可見的語意／paint surface，並正確穿透空白 shim。
- **Capture／replay fidelity**：persisted bounds 的 IoU、click-to-persist latency，以及 replay 是否 exactly once。

每個 hover case 量測三次端到端 latency；數值包含 Playwright、CDP 與瀏覽器事件／render round trip，所以適合做相同環境下的 regression comparison，不應解讀為 selector 純 CPU 時間。一般執行只 gate accuracy／IoU／exactly-once；若已有 reference baseline，可用下列方式啟用 latency regression gate：

```bash
HOWBEAM_BENCHMARK_STRICT_LATENCY=1 pnpm benchmark:detection
```

結果寫入：

```text
test-results/benchmarks/detection-benchmark.json
test-results/benchmarks/detection-benchmark.md
```

確認 corpus、oracle 或執行環境有合理變更後，才更新 reference baseline：

```bash
pnpm benchmark:detection:update-baseline
```

Baseline 只保存 regression thresholds 與參考數字，不應為了掩蓋 accuracy failure 而更新；失敗案例必須先判斷是 oracle 錯誤或 production 演算法 regression。
