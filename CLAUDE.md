# CLAUDE.md

## 驗證
- 套件管理一律使用 `pnpm`，不使用 `npm` / `npx`（執行工具用 `pnpm exec`）
- 每次改動程式碼後，必須在 `extension/` 執行 `pnpm build`，確認建置成功再回報完成
- 建置失敗時如實回報錯誤，不可宣稱完成
