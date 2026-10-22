# PDF 匯出字型

PDF 匯出把文字嵌成真正的向量文字，字型由 `public/fonts/pdf/` 提供：

| 檔案 | 說明 |
|---|---|
| `HowbeamSansTC-Regular.ttf` / `HowbeamSansTC-Bold.ttf` | 由官方 Noto Sans TC 產出的子集 |
| `OFL.txt` | 上游的 SIL OFL 1.1 授權全文，與字型一起散布 |
| `manifest.json` | 來源版本、參數與每個檔案的 SHA-256 |

這些檔案是產物，**不要手動修改**；測試（`tests/unit/pdf-fonts.test.ts`）會比對 `manifest.json` 的雜湊值。

## 重新產生

需要 Python 3 與 fonttools：

```bash
pip install -r scripts/pdf-fonts/requirements.txt
python scripts/pdf-fonts/build.py
```

腳本會從 `sources.json` 釘選的 [google/fonts](https://github.com/google/fonts) commit 下載
`NotoSansTC[wght].ttf` 與 `OFL.txt` 到 `scripts/pdf-fonts/.cache/`，核對大小與 SHA-256 後才使用；
來源與釘選不符時會中止。相同輸入一定產出相同位元組。

## 做了什麼

1. 把可變字型實例化成 Regular（wght 400）與 Bold（wght 700）。
2. 只保留匯出會用到的字元：Big5 第一級常用字（5,401 字）、Latin、標點、箭頭、帶圈數字、
   日文假名、注音符號與全形符號，共 6,575 個碼位。
3. 只保留 `kern`、`ccmp` 排版特徵，移除 hinting 與字形名稱。
4. 改名為 **Howbeam Sans TC**。

## 授權

Noto Sans TC 以 SIL Open Font License 1.1 授權，著作權人 Adobe，宣告的保留字型名稱是 `Source`。
子集化屬於修改版（[OFL FAQ 2.6](https://openfontlicense.org/ofl-faq/)），因此：

- 字型內部名稱改為 Howbeam Sans TC，不使用 `Source`，連 `Noto` 也一併不用，避免被誤認為原版。
- 字型檔內的著作權（name ID 0）與授權（name ID 13、14）紀錄原樣保留，旁邊附上 `OFL.txt`。
- 修改版仍以 OFL 散布，不改授權。

PDF 內嵌入字型子集不受上述限制（OFL FAQ 1.12），產出的 PDF 不受 OFL 約束。

## 更新字型版本

1. 在 google/fonts 找到新的 commit，更新 `sources.json` 的 `commit`、`bytes` 與 `sha256`。
2. 重新執行 `build.py`，把更新後的 `public/fonts/pdf/` 一併提交。
3. 執行 `pnpm test:unit`，確認涵蓋度、名稱與體積預算仍然成立。
