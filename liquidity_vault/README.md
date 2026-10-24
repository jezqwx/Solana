# Week 8 — Liquidity Vault skeleton

Существующий проект Anchor **0.31.1**. Program ID:
`DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9`.
`anchor-lang` и `anchor-spl` закреплены на 0.31.1; SPL features:
`token`, `associated_token`, `mint`. Используется классический SPL Token Program,
без Token-2022. Deposit, withdraw и выпуск shares пока не реализованы.

## Архитектура аккаунтов

| Аккаунт | Данные / назначение | Владелец аккаунта в Solana | Размер |
| --- | --- | --- | --- |
| `VaultConfig` | `admin`, `asset_mint`, `share_mint`, `token_vault`: Pubkey; `total_deposited`: u64; `bump`: u8 | Liquidity Vault program | 145 байт, включая discriminator 8 байт |
| `UserPosition` | `owner`, `vault`: Pubkey; `deposited_amount`: u64; `bump`: u8 | Liquidity Vault program | 81 байт, включая discriminator 8 байт |
| `ShareMint` | decimals = asset mint decimals; mint authority = VaultConfig PDA; freeze authority = None; supply = 0 | SPL Token Program | 82 байта |
| `Token Vault` | ATA для asset mint; token authority (`owner` в SPL-данных) = VaultConfig PDA; amount = 0 | SPL Token Program | 165 байт |
| `AssetMint` | Существующий инициализированный SPL mint; тест создаёт отдельный mint с decimals = 6 | SPL Token Program | 82 байта |

Различайте владельца Solana-аккаунта (программа) и authority внутри SPL-данных.
ShareMint — PDA программы, но после создания аккаунтом владеет Token Program.

## Точные PDA seeds

Все ключи ниже — **32 сырых байта публичного ключа**, не текст base58.
К seeds при derivation добавляется найденный canonical bump.

- VaultConfig: `[b"vault", asset_mint.key().as_ref()]` под Program ID Liquidity Vault.
- ShareMint: `[b"share-mint", vault.key().as_ref()]` под Program ID Liquidity Vault.
- UserPosition: `[b"position", vault.key().as_ref(), user.key().as_ref()]` под Program ID Liquidity Vault.
- Token Vault ATA: `[vault.key().as_ref(), TOKEN_PROGRAM_ID.as_ref(), asset_mint.key().as_ref()]`
  под Associated Token Program (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).
  `TOKEN_PROGRAM_ID = TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
  В TypeScript: `getAssociatedTokenAddressSync(assetMint, vault, true)`;
  `true` разрешает off-curve owner PDA.

## Инструкции и проверки

`initialize_vault`: admin подписывает и оплачивает создание VaultConfig,
ShareMint и ATA. Сохраняются ключи и bump, `total_deposited = 0`.
Отсутствие `mint::freeze_authority` при `init` в Anchor 0.31.1 означает `None`;
это дополнительно проверяется в handler.

`open_position`: user подписывает и оплачивает новую UserPosition для существующего
VaultConfig, `deposited_amount = 0`. Vault проверяется по seeds и сохранённому bump;
передавать повторно asset mint, share mint или ATA этой инструкции не требуется.

Типизированные аккаунты проверяют program owner, инициализацию mint и подписи.
Anchor constraints проверяют PDA, token program, mint authority, decimals и ATA.
Используется `init`, поэтому повторное создание того же vault/position завершается
ошибкой, существующие данные не сбрасываются. Пользовательские ошибки:
`IdenticalMints` (asset и share должны различаться),
`ShareMintFreezeAuthoritySet` (у share mint не должно быть freeze authority).
Неверные seeds/owner/signature возвращают стандартные ошибки Anchor;
повторный `init` — ошибку создания уже занятого аккаунта Anchor/System Program.

## Команды

В WSL Ubuntu:

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault
cargo fmt --check
yarn install
anchor build
yarn tsc --noEmit
```

Сборка создаёт `.so`, IDL и TypeScript-типы в `target/`; интеграционный тест
не запускается ни сборкой, ни установкой зависимостей, ни проверкой типов.

Единственный integration test в `tests/liquidity_vault.ts` создаёт отдельный asset
mint, вычисляет PDA/ATA, вызывает обе инструкции и проверяет owner/authority,
связи аккаунтов, bump, decimals, freeze authority, точные размеры и нулевые суммы.
Без `RUN_DEVNET_INTEGRATION=1` Mocha пропускает сценарий. Перед первой транзакцией
тест проверяет genesis hash Devnet и ожидаемый Program ID.

**Только для осознанного ручного запуска в будущем**, когда эта версия программы
уже развёрнута и кошелёк пополнен тестовыми SOL:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json" \
RUN_DEVNET_INTEGRATION=1 \
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/liquidity_vault.ts
```

Эта команда отправляет транзакции и расходует Devnet SOL на комиссии и rent.
В рамках реализации skeleton она не выполнялась. `anchor deploy` и `anchor test`
также не выполнялись. `Anchor.toml` настроен на Devnet и кошелёк
`~/.config/solana/jezqwx/id.json`; это публичная тестовая сеть, не mainnet.
Не используйте реальные активы или основной кошелёк. Не публикуйте seed phrase,
private keys, wallet JSON или `target/deploy/liquidity_vault-keypair.json`.
Program keypair и Program ID должны оставаться прежними; не запускайте генерацию
замены keypair или `anchor keys sync` для смены ID. `target/` исключён из git.

## Explorer links

- Program: https://explorer.solana.com/address/DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9?cluster=devnet
- Asset mint: _добавить после ручного теста_
- VaultConfig / ShareMint / Token Vault / UserPosition: _добавить после ручного теста_
- initialize_vault transaction: _добавить после ручного теста_
- open_position transaction: _добавить после ручного теста_

Шаблоны: `https://explorer.solana.com/address/<ADDRESS>?cluster=devnet` и
`https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`.
Наличие ссылки на программу не подтверждает deployment этой версии.

Справка: [исходники Anchor v0.31.1](https://github.com/coral-xyz/anchor/tree/v0.31.1).
