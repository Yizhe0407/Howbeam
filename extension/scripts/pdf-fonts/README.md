# PDF 匯出字型

PDF 匯出把文字嵌成真正的向量文字，字型由 `public/fonts/pdf/` 提供：

| 檔案 | 說明 |
|---|---|
| `HowbeamSansTC-*.woff2` | 由官方 Noto Sans TC 產出，保留全部字元 |
| `HowbeamSansSC-*.woff2` / `HowbeamSansJP-*.woff2` | 由 Noto Sans SC / JP 產出，只保留前面字型沒有的字元 |
| `HowbeamSymbols-*.woff2` / `HowbeamSymbols2-Regular.woff2` | 由 Noto Sans Symbols / Symbols 2 產出 |
| `HowbeamEmoji-*.woff2` | 由 Noto Emoji（單色）產出 |
| `OFL.txt` / `OFL-Symbols.txt` / `OFL-Emoji.txt` | 上游的 SIL OFL 1.1 授權全文，與字型一起散布 |
| `manifest.json` | 來源版本、字型查找順序（`chain`）與每個檔案的 SHA-256 |

這些檔案是產物，**不要手動修改**；測試（`tests/unit/pdf-fonts.test.ts`）會比對 `manifest.json` 的雜湊值。

## 字型查找順序

匯出時每個字元群（含 emoji 的組合序列）依 `chain` 的順序，交給第一個有對應字形的字型繪製，
跟瀏覽器的字型後備一樣：繁中 → 簡中補字 → 日文補字 → Symbols → Symbols 2 → Emoji。
所有字型都沒有的字元才會留在第一個字型，畫成缺字方框。
PDF 只嵌入實際用到的字形，所以字型檔大小只影響擴充套件，不影響 PDF。

執行時的順序寫在 `lib/export/pdf/pdf-fonts.ts` 的 `PDF_FONT_CHAIN`，測試會確認它與 `manifest.json` 一致。

## 重新產生

需要 Python 3 與 fonttools、brotli：

```bash
pip install -r scripts/pdf-fonts/requirements.txt
python scripts/pdf-fonts/build.py
```

腳本會從 `sources.json` 釘選的 [google/fonts](https://github.com/google/fonts) commit 下載字型與授權
到 `scripts/pdf-fonts/.cache/`，核對大小與 SHA-256 後才使用；來源與釘選不符時會中止。相同輸入一定產出相同位元組。

## 做了什麼

1. 把可變字型實例化成 Regular（wght 400）與 Bold（wght 700）；沒有粗細軸的字型（Symbols 2）只有 Regular，粗體文字也用它。
2. 補字字型只保留前面字型沒有的字元。
3. 中日文字型只保留 `kern`、`ccmp` 排版特徵；符號與 emoji 保留全部特徵，emoji 組合序列才能正確合字。移除 hinting 與字形名稱。
4. 改名為 **Howbeam Sans TC / SC / JP**、**Howbeam Symbols**、**Howbeam Symbols 2**、**Howbeam Emoji**。
5. 存成 WOFF2，但 `glyf`、`loca` 不做 WOFF2 轉換：PDFKit 用 fontkit 嵌入字型，
   fontkit 無法從轉換後的格式重建 `loca`，嵌入時會失敗。

## 授權

所有來源字型都以 SIL Open Font License 1.1 授權。Noto Sans TC / SC / JP 的著作權人是 Adobe，
宣告的保留字型名稱是 `Source`。子集化屬於修改版（[OFL FAQ 2.6](https://openfontlicense.org/ofl-faq/)），因此：

- 字型內部名稱一律改為 Howbeam 開頭，不使用 `Source`，連 `Noto` 也一併不用，避免被誤認為原版。
- 字型檔內的著作權（name ID 0）與授權（name ID 13、14）紀錄原樣保留，旁邊附上各自的 OFL 全文。
- 修改版仍以 OFL 散布，不改授權。

PDF 內嵌入字型子集不受上述限制（OFL FAQ 1.12），產出的 PDF 不受 OFL 約束。

## 更新字型版本

1. 在 google/fonts 找到新的 commit，更新 `sources.json` 的 `commit`、`bytes` 與 `sha256`。
2. 重新執行 `build.py`，把更新後的 `public/fonts/pdf/` 一併提交。
3. 執行 `pnpm test:unit`，確認涵蓋度、名稱與體積預算仍然成立。
