# Liquidity Vault — Week 8 skeleton + Week 9 Deposit

Существующий проект Anchor **0.31.1**. Program ID:
`DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9`.
`anchor-lang` и `anchor-spl` закреплены на 0.31.1; SPL features:
`token`, `associated_token`, `mint`. Используется классический SPL Token Program,
без Token-2022. Week 9 добавляет deposit и выпуск shares. Withdraw пока отсутствует.

## Архитектура аккаунтов

| Аккаунт | Данные / назначение | Владелец аккаунта в Solana | Размер |
| --- | --- | --- | --- |
| `VaultConfig` | `admin`, `asset_mint`, `share_mint`, `token_vault`: Pubkey; `total_deposited`: u64; `bump`: u8 | Liquidity Vault program | 145 байт, включая discriminator 8 байт |
| `UserPosition` | `owner`, `vault`: Pubkey; `deposited_amount`: u64; `bump`: u8 | Liquidity Vault program | 81 байт, включая discriminator 8 байт |
| `ShareMint` | decimals = asset mint decimals; mint authority = VaultConfig PDA; freeze authority = None; начальный supply = 0 | SPL Token Program | 82 байта |
| `Token Vault` | ATA для asset mint; token authority (`owner` в SPL-данных) = VaultConfig PDA; начальный amount = 0 | SPL Token Program | 165 байт |
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

## Week 9 — deposit(amount: u64, min_shares_out: u64)

Оба аргумента задаются в минимальных единицах соответствующего токена.
В TypeScript передавайте `anchor.BN`; для больших u64 используйте десятичную
строку, а не JavaScript `number`. Программа не использует floating point.

Перед депозитом пользователь открывает UserPosition и создаёт свои SPL token
accounts (обычно ATA): один для asset mint, другой для share mint. Deposit не
создаёт аккаунты и не требует admin-подписи. Оба пользовательских token accounts
должны принадлежать подписавшему `user`; подпись делегата вместо owner не принимается.

### Расчёт shares

`A = token_vault.amount`, `S = share_mint.supply` считываются **до перевода**.

```text
A == 0 и S == 0: shares = amount
A > 0 и S > 0:  shares = floor(amount * S / A)
иначе:          InvalidVaultState
```

Первый депозит в пустой vault выпускает shares 1:1; decimals mint совпадают.
Последующие депозиты используют фактические активы, а не `total_deposited`.
Например, при A=200 и S=100 депозит 51 выпускает 25 shares.
`min_shares_out=25` допускает его, `min_shares_out=26` отклоняет.
`min_shares_out=0` отключает только пользовательский нижний предел: нулевой
депозит и нулевой выпуск shares всё равно запрещены.

Умножение/деление выполняются checked-операциями над u128; результат проверяемо
преобразуется в u64. До CPI проверяются баланс пользователя, переполнения обоих
счётчиков, баланса Token Vault, supply и баланса shares получателя.

### Accounts и выполнение

| Account | Доступ | Проверки |
| --- | --- | --- |
| `user` | signer | Подпись владельца пользовательских token accounts и позиции |
| `vault` | writable | Прежние vault seeds/bump; связи с asset mint, share mint, token vault |
| `position` | writable | Прежние position seeds/bump; owner=user; vault совпадает |
| `asset_mint` | readonly | Инициализированный классический SPL Mint из конфигурации |
| `share_mint` | writable | Прежние share-mint seeds; mint authority=vault; decimals=asset; freeze authority=None |
| `token_vault` | writable | Адрес из конфигурации; канонический ATA asset mint с authority=vault |
| `user_asset_account` | writable | SPL owner программы; mint=asset; token authority=user |
| `user_share_account` | writable | SPL owner программы; mint=share; token authority=user |
| `token_program` | readonly | Фиксированный классический SPL Token Program |

После проверок `transfer_checked` переводит `amount` из пользовательского asset
account в Token Vault с подписью пользователя. Затем `mint_to` выпускает
рассчитанные shares в пользовательский share account с PDA-подписью:
`[b"vault", asset_mint.key().as_ref(), &[vault.bump]]`.

После успешных CPI увеличиваются `VaultConfig.total_deposited` и
`UserPosition.deposited_amount` на `amount`. Это накопленные суммы депозитов;
прямые переводы в vault их не изменяют. Ошибка откатывает изменения всей
транзакции; возможная комиссия Solana не является частью этих счётчиков.

В `Deposit` используются `Box<Account<...>>`, чтобы уложиться в лимит SBF-стека.
Схемы, discriminator, размеры существующих аккаунтов и все PDA seeds сохранены.

### Ошибки и ограничения

Новые ошибки добавлены после Week 8, сохраняя прежние номера:
`ZeroDeposit`, `ZeroShares`, `SlippageExceeded`, `InvalidVaultState`,
`ArithmeticOverflow`, `InsufficientAssetBalance`, `InvalidAssetMint`,
`InvalidShareMint`, `InvalidTokenVault`, `InvalidPositionOwner`, `InvalidPositionVault`.
Неправильные seeds, program owner, подпись и token authority также отклоняются
стандартными constraints Anchor. Замороженные token accounts отклоняет SPL Token.

- Прямое пополнение vault увеличивает цену shares. Округление вниз оставляет
  остаток действующим держателям; задавайте осмысленный `min_shares_out`.
- При ненулевых активах и нулевом supply депозит отклоняется. Предварительная
  donation до первого депозита может заблокировать vault; автоматического
  присвоения этих активов первому вкладчику или механизма восстановления нет.
  Аналогичное состояние возможно после сжигания всех shares их держателями.
- Shares можно переводить и сжигать. `deposited_amount` — история депозитов,
  а не текущая доля пользователя; будущий withdraw должен учитывать shares.
- Asset mint может иметь freeze authority: его администратор способен
  заморозить token accounts и остановить переводы.
- Withdraw отсутствует: внесённые активы пока нельзя вывести через программу.
  Используйте только отдельные тестовые mint на Devnet, не реальные активы.

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

Сохранённый integration test Week 8 в `tests/liquidity_vault.ts` создаёт отдельный asset
mint, вычисляет PDA/ATA, вызывает обе инструкции и проверяет owner/authority,
связи аккаунтов, bump, decimals, freeze authority, точные размеры и нулевые суммы.
Новые сценарии Week 9 создают отдельный mint/vault для каждого теста и проверяют:
первый и повторный депозит, donation и пропорциональный выпуск с округлением,
второго пользователя, равенство результата `min_shares_out`, отказ при слишком
большом minimum, нулевой amount/выпуск, недостаток средств, неверные mint/PDA/
token accounts/owner/program и предзаполненный vault с нулевым supply.
После ожидаемой ошибки сравниваются данные аккаунтов до/после. Проверяется
конкретный Anchor error code: сетевой сбой не считается успешным негативным тестом.

В `lib.rs` добавлены три unit-теста расчёта: округление/1:1, отказы/нижний предел,
u128-произведение и границы u64. В рамках реализации Week 9 отдельно они не запускались.

Без `RUN_DEVNET_INTEGRATION=1` Mocha пропускает обе группы. Перед первой транзакцией
каждая группа проверяет полный genesis hash Devnet и ожидаемый Program ID.
Week 8 сохранён, включая raw-send для initialize и существующий `.rpc()` для
openPosition. Новые транзакции Week 9 используют `.transaction()`/инструкции,
свежий blockhash `confirmed`, подпись кошельком, `sendRawTransaction` с включённым
preflight и `maxRetries=0`, затем `confirmTransaction` с тем же blockhash и
lastValidBlockHeight. Проверяется `confirmation.value.err`; диагностика выводит
публичные адреса, подписи, blockhash и RPC-логи, но не private keys.

**Только для осознанного ручного запуска в будущем**, когда эта версия программы
уже развёрнута и кошелёк пополнен тестовыми SOL:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json" \
RUN_DEVNET_INTEGRATION=1 \
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/liquidity_vault.ts
```

Эта команда отправляет транзакции и расходует Devnet SOL на комиссии и rent.
При реализации Week 9 эта команда, Devnet-транзакции, `anchor deploy` и `anchor test`
не выполнялись. Локальная сборка сама по себе не обновляет развёрнутую программу:
для будущего ручного тестирования нужна отдельно согласованная публикация версии
с инструкцией deposit. `Anchor.toml` настроен на Devnet и кошелёк
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
- deposit transactions: _добавить после ручного теста Week 9_

Шаблоны: `https://explorer.solana.com/address/<ADDRESS>?cluster=devnet` и
`https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`.
Наличие ссылки на программу не подтверждает deployment этой версии.

Справка: [исходники Anchor v0.31.1](https://github.com/coral-xyz/anchor/tree/v0.31.1).
