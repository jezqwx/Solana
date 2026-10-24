# Liquidity Vault — Weeks 8–11

Существующий проект Anchor **0.31.1**. Program ID:
`DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9`.
`anchor-lang` и `anchor-spl` закреплены на 0.31.1; SPL features:
`token`, `associated_token`, `mint`. Используется классический SPL Token Program,
без Token-2022. Week 9 добавляет deposit и выпуск shares; Week 10 — withdraw
со сжиганием shares и возвратом asset-токенов через CPI.

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
  а не текущая доля пользователя; withdraw использует реальный баланс shares.
- Asset mint может иметь freeze authority: его администратор способен
  заморозить token accounts и остановить переводы.
- Используйте только отдельные тестовые mint на Devnet, не реальные активы.

## Week 10 — withdraw(shares_to_burn: u64, min_assets_out: u64)

`shares_to_burn` — количество shares в минимальных единицах share mint;
`min_assets_out` — минимальная выплата в минимальных единицах asset mint.
Для TypeScript используйте `anchor.BN`, для больших u64 — строковое представление.

До выполнения CPI считываются текущий баланс Token Vault и supply ShareMint:

```text
B = shares_to_burn
A = token_vault.amount до burn/transfer
S = share_mint.supply до burn/transfer
assets_out = floor(B * A / S)
```

Расчёт использует checked-арифметику u128 и проверяемое преобразование в u64.
Проверяются `B > 0`, `A > 0`, `S > 0`, `B <= S`, достаточный баланс shares
пользователя, ненулевая выплата и `assets_out >= min_assets_out`.
До CPI также проверяются вычитания из token balances/supply и переполнение
asset balance получателя. `min_assets_out=0` разрешает любой положительный
результат, но не отключает остальные проверки.

Пример: A=151, S=100, B=33 даёт 49 asset units. После вывода A=102 и S=67;
последние 67 shares возвращают все оставшиеся 102 units. При B=S vault полностью
опустошается без остатка округления. Последующий deposit при A=S=0 снова выпускает
shares 1:1, продолжая накопление истории депозитов.

### Право на вывод и исторические счётчики

**`VaultConfig.total_deposited` и `UserPosition.deposited_amount` — исторические
накопительные показатели. Withdraw НЕ уменьшает и вообще НЕ записывает их.**
Они не являются текущим балансом, лимитом вывода или оценкой доли пользователя.
Donation может увеличить выплату сверх исторического депозита. Получатель
переведённых shares вправе вывести их, даже если его `deposited_amount=0`.
Он предварительно открывает свою позицию через `open_position` и создаёт asset
token account. Право на вывод определяется подписью owner и балансом его
share token account; делегат вместо owner не принимается.

`Withdraw` использует те же девять имён аккаунтов и проверки связей, что `Deposit`.
`vault` и `position` в Withdraw **readonly**; asset mint и Token Program также
readonly. Share mint, Token Vault и оба пользовательских token accounts writable.
PDA/ATA, mint, program owner, token authority, подпись пользователя и принадлежность
позиции проверяются до CPI. Аккаунты обёрнуты в `Box<Account<...>>` для SBF-стека.
Структуры и размеры остаются прежними: VaultConfig 145 байт, UserPosition 81 байт.
Новых аккаунтов состояния, статистических PDA, миграции, realloc и закрытия
существующих аккаунтов нет. Program ID и все прежние seeds сохранены.

### Два CPI и inner instructions

CPI (Cross-Program Invocation) — вызов другой программы внутри текущей инструкции.
Внешняя инструкция `Liquidity Vault: withdraw` последовательно вызывает:

1. SPL Token `Burn`: сжечь B shares из `user_share_account` в `share_mint`;
   authority=`user`. Используется подпись пользователя из внешней транзакции.
2. SPL Token `TransferChecked`: перевести `assets_out` из `token_vault` в
   `user_asset_account`; mint=`asset_mint`, decimals берутся из mint;
   authority=`vault`. Программа использует `CpiContext::new_with_signer` и seeds
   `[b"vault", asset_mint.key().as_ref(), &[vault.bump]]`.

У PDA нет приватного ключа: runtime проверяет seeds относительно Program ID и
предоставляет PDA полномочия signer только для CPI. Inner instructions не имеют
отдельных transaction signatures — оба CPI относятся к одной внешней транзакции.
Mint authority Vault PDA не требуется для burn собственных shares пользователем.

Ошибка второго CPI откатывает также первый: burn и transfer атомарны.
Внутри handler расчёт производится по состоянию до CPI; устаревшие значения
десериализованных SPL-аккаунтов после CPI не используются. В клиентских проверках
состояние читается повторно после подтверждения транзакции.

Новые ошибки добавлены после прежних, сохраняя их номера: `ZeroWithdrawal`,
`InsufficientShareBalance`, `ZeroAssetsOut`, `WithdrawalSlippageExceeded`.
Переиспользуются `InvalidVaultState`, `ArithmeticOverflow` и ошибки аккаунтов.

### Проверка вывода в Solana Explorer

После отдельно разрешённого Devnet-запуска:

1. Скопировать подпись из `[withdraw] Transaction submitted` и открыть
   `https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`.
2. Проверить сеть Devnet, успешный статус и Program ID Liquidity Vault у внешней
   инструкции. До выполнения сверки убедиться, что транзакция подтверждена.
3. В деталях инструкции раскрыть inner instructions: сначала SPL Token Burn,
   затем TransferChecked. Сверить mint, source, destination, authority и суммы.
4. В логах проверить последовательность вызовов Token Program и успешное
   завершение обеих CPI и внешней инструкции. PDA vault не должен фигурировать
   как отдельная подпись кошелька транзакции.
5. По token balance changes сверить: shares пользователя уменьшились на B,
   asset balance vault уменьшился на assets_out, asset balance пользователя
   увеличился на assets_out. Supply share mint после burn уменьшается на B;
   состояние mint в Explorer показывает уже текущий supply и может включать
   более поздние транзакции.
6. Исторические счётчики и размеры VaultConfig/UserPosition проверить через
   Anchor account fetch или декодирование данных: они не меняются при withdraw.

Если Explorer не декодирует название withdraw без опубликованного IDL, сверяйте
Program ID и локальный `target/idl/liquidity_vault.json`; SPL inner instructions
проверяйте отдельно по Token Program, аккаунтам и суммам.

Программно аналогичная проверка использует `getParsedTransaction` и
`meta.innerInstructions`: поле `index` указывает внешнюю инструкцию, а вложенные
parsed-типы — `burn` и `transferChecked`. Общий helper сохраняет подписанный
blockhash, оставляет preflight включённым и не повторяет отправку автоматически.

### Тесты Week 10 и ограничения

Новая вложенная группа `Week 10 — withdraw` переиспользует подготовку Week 9;
пять прежних интеграционных тестов Week 8–9 сохранены. Пять новых сценариев:

- частичный/полный вывод после donation, округление, CPI metadata, сохранение
  исторических аккаунтов байт-в-байт и новый deposit после опустошения vault;
- вывод переданных shares другим пользователем с нулевой историей депозитов;
- нулевой запрос, пустой vault, превышение supply/личного баланса и slippage;
- подмена mint, PDA, token accounts, owner, Token Program и отсутствие подписи;
- ошибка TransferChecked после Burn в preflight при замороженном asset account:
  проверяются логи обоих CPI, неизменность состояния и успешный полный вывод
  после thaw. Preflight не отключается; ошибочная транзакция не публикуется.

В Rust добавлены четыре локальных теста: формула/округление/последний держатель,
отказы и slippage, границы u128/u64 и сохранение размеров аккаунтов. `ZeroAssetsOut`
проверяется локально на A<S: обычная последовательность операций Week 8–10
без потерь активов такого состояния не создаёт. Добавленные тесты в рамках
реализации не запускались отдельно; выполнялись только локальные проверки сборки.

Остаются ограничения: donation до первого депозита и внешнее сжигание всех shares
могут оставить A>0/S=0 без доступного вывода; механизм восстановления не добавлен.
Asset freeze authority может блокировать переводы. Нулевой min_assets_out не
защищает от невыгодного курса. Публичный RPC может вернуть 429 или временно не
предоставить metadata подтверждённой транзакции; это ошибка инфраструктуры, а не
успешный негативный тест. Слепые повторы транзакций не используются.

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

Без `RUN_DEVNET_INTEGRATION=1` Mocha пропускает все группы. Перед первой транзакцией
верхнеуровневая группа проверяет полный genesis hash Devnet и ожидаемый Program ID;
вложенная Week 10 наследует эту проверку из setup Week 9.
Week 8 использует raw-send для initialize и общий helper для openPosition.
Транзакции Week 9–10 используют `.transaction()`/инструкции,
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
При реализации Week 10 эта команда, Devnet-транзакции, `anchor deploy` и `anchor test`
не выполнялись. Локальная сборка сама по себе не обновляет развёрнутую программу:
для будущего ручного тестирования нужна отдельно согласованная публикация версии
с инструкцией withdraw. `Anchor.toml` настроен на Devnet и кошелёк
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
- withdraw transactions / inner instructions: _добавить после ручного теста Week 10_

Шаблоны: `https://explorer.solana.com/address/<ADDRESS>?cluster=devnet` и
`https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`.
Наличие ссылки на программу не подтверждает deployment этой версии.

Справка: [исходники Anchor v0.31.1](https://github.com/coral-xyz/anchor/tree/v0.31.1).
Описание CPI: https://solana.com/docs/core/cpi.
Атомарность транзакций: https://solana.com/docs/core/transactions.

## Week 11 — AMM и концентрированная ликвидность

Созданы собственные классические SPL-токены, Raydium CLMM-пул и одна позиция
**кошелька** в Solana Devnet. Week 11 реализована отдельным клиентом
[`week11/`](week11/README.md), адаптирующим официальные SDK V2 demo
`createPool.ts` и `createPositionFromLiquidity.ts`. Все публичные адреса,
параметры и signatures находятся в
[`manifest.devnet.json`](week11/manifest.devnet.json).

Код и deployment Liquidity Vault не изменялись. Week 8–10 остаются самостоятельным
одноактивным vault; его активы не переводились в Raydium. Существующие 10 Devnet
интеграционных тестов повторно не запускались. До операций снят снимок **136
аккаунтов**, включая 31 VaultConfig, их share mint, Token Vault и существующие
UserPosition. После операций совпали owner, длина, lamports и SHA-256 данных всех
аккаунтов: [`vault-baseline.devnet.json`](week11/vault-baseline.devnet.json).

### Адреса Devnet

| Объект | Адрес / Explorer |
| --- | --- |
| Кошелёк, владелец позиции | [bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe](https://explorer.solana.com/address/bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe?cluster=devnet) |
| Официальный Raydium CLMM | [DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH](https://explorer.solana.com/address/DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH?cluster=devnet) |
| GUL-A, token0 | [6USW7mimGN27RwZjLBoywVH9TJAVukg1jvscso5kAnvy](https://explorer.solana.com/address/6USW7mimGN27RwZjLBoywVH9TJAVukg1jvscso5kAnvy?cluster=devnet) |
| GUL-B, token1 | [GtQoCfFeNdcvcoDCusK3s8od9JRP27Sw4g2LcJqb5Ka1](https://explorer.solana.com/address/GtQoCfFeNdcvcoDCusK3s8od9JRP27Sw4g2LcJqb5Ka1?cluster=devnet) |
| CLMM-пул | [gftP6PpRANU2cNY1aRXCGXv2gYjGgLYQLWuw41rbDrf](https://explorer.solana.com/address/gftP6PpRANU2cNY1aRXCGXv2gYjGgLYQLWuw41rbDrf?cluster=devnet) |
| AmmConfig, index 0 | [CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu](https://explorer.solana.com/address/CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu?cluster=devnet) |
| Pool token0 vault | [Bu3sjqQQRBurbdRJ85EV6s9odkQfPnAsGYXiBo9kp222](https://explorer.solana.com/address/Bu3sjqQQRBurbdRJ85EV6s9odkQfPnAsGYXiBo9kp222?cluster=devnet) |
| Pool token1 vault | [HVpYLZewY65hhhPSPR1koHmERQfXoCqkfudKwtgjiBSo](https://explorer.solana.com/address/HVpYLZewY65hhhPSPR1koHmERQfXoCqkfudKwtgjiBSo?cluster=devnet) |
| Observation | [EgrpcnywpsvEiRAZNQsKPKx7Z6s27fyLVwGpPDqCaHbM](https://explorer.solana.com/address/EgrpcnywpsvEiRAZNQsKPKx7Z6s27fyLVwGpPDqCaHbM?cluster=devnet) |
| Tick bitmap extension | [GNbsWc1ZzwfzQoMNJpoUEJdQxDp6Am8JpyxFywWqRUg4](https://explorer.solana.com/address/GNbsWc1ZzwfzQoMNJpoUEJdQxDp6Am8JpyxFywWqRUg4?cluster=devnet) |
| NFT mint | [ErjZbudrBuoqt66nqm5UQfHuB9m1zWg5PvEwCpmFA9JG](https://explorer.solana.com/address/ErjZbudrBuoqt66nqm5UQfHuB9m1zWg5PvEwCpmFA9JG?cluster=devnet) |
| NFT ATA кошелька | [GiceKAs4mZU6ENRbmiN93e2vzbHFAmyYsSBWhSAmeWDk](https://explorer.solana.com/address/GiceKAs4mZU6ENRbmiN93e2vzbHFAmyYsSBWhSAmeWDk?cluster=devnet) |
| Personal position | [P2fxUUpgMEQfkfbEqyC1t4sTSgw8DM3wW7QCnYKYeTs](https://explorer.solana.com/address/P2fxUUpgMEQfkfbEqyC1t4sTSgw8DM3wW7QCnYKYeTs?cluster=devnet) |
| Lower tick array | [BjY2zbtvFwx2PWc8hyTJSqgRouD5Y2mci54zgZYLvub6](https://explorer.solana.com/address/BjY2zbtvFwx2PWc8hyTJSqgRouD5Y2mci54zgZYLvub6?cluster=devnet) |
| Upper tick array | [8x9Yg5ep6kAfK3c3y7F3vAvvy8TMkwxB9iVzV9RtK68s](https://explorer.solana.com/address/8x9Yg5ep6kAfK3c3y7F3vAvvy8TMkwxB9iVzV9RtK68s?cluster=devnet) |

GUL-A/GUL-B — метки в скриптах и документации, а не опубликованные metadata.
У обоих mint decimals=6, supply=1 000 000 токенов, mint authority=кошелёк,
freeze authority=None. NFT классический SPL, decimals=0, supply=1, баланс NFT ATA=1.
Metaplex metadata не создавались; derived metadata/protocol-position адреса в
манифесте являются адресами интерфейса инструкции, а не обещанием наличия аккаунта.

### Цена, диапазон и внесённая ликвидность

- Канонический порядок mint: GUL-A=token0, GUL-B=token1, сравнение сырых pubkey.
- Начальная и фактическая цена при проверке: **1 GUL-A = 1 GUL-B**.
- `sqrtPriceX64 = 18446744073709551616` (2^64), текущий tick=0.
- Комиссия пула **0,25%**, tick spacing **60**; конфигурация проверена on-chain.
- Диапазон ticks **[-1080, 960)**; цены границ **0.89763244330945058506** и
  **1.1007537807153331814** GUL-B за GUL-A.
- Внесено **1000 GUL-A** и **1121.658824 GUL-B**; суммы подтверждены metadata
  транзакции. Остатки ATA: **999000 GUL-A**, **998878.341176 GUL-B**.
- Liquidity позиции и активная liquidity пула: **21338374629**.

Выбран учебный диапазон около ±10% от начальной цены. Нижняя граница округлена
вниз, верхняя вверх до допустимых ticks, поэтому фактический диапазон немного
шире. При цене внутри диапазона вносится оба токена. Это не прогноз цены и не
торговая рекомендация. При выходе цены за диапазон позиция теряет активность;
равные nominal token amounts не требуются, поскольку границы не симметричны
в пространстве sqrtPrice. Последующие сделки могут изменить цену — `yarn read`
читает её заново, значения выше являются снимком завершения Week 11.

### Транзакции и расходы

| Операция | Подтверждённая транзакция |
| --- | --- |
| Два mint, ATA и выпуск токенов | [5ez4g4DVeWTvaJNz5YRxTE52h8Gw3EXwkJs871QXfUKhAMiYPpfUJPhkD3mwbCr7nMiJJ99pK5tgC95WRdDqCu3E](https://explorer.solana.com/tx/5ez4g4DVeWTvaJNz5YRxTE52h8Gw3EXwkJs871QXfUKhAMiYPpfUJPhkD3mwbCr7nMiJJ99pK5tgC95WRdDqCu3E?cluster=devnet) |
| Создание пула | [Df5HiZSpYpxYGaXXQZEEqmGGbhrsnJVP8sovx3NUpphEFAdSvkTHxaJxDNZMZD6nrAHDUoPztV2mtkN9zoXaoGf](https://explorer.solana.com/tx/Df5HiZSpYpxYGaXXQZEEqmGGbhrsnJVP8sovx3NUpphEFAdSvkTHxaJxDNZMZD6nrAHDUoPztV2mtkN9zoXaoGf?cluster=devnet) |
| Открытие и финансирование позиции | [3KxcQDP582a3TZnYdPdyrnMt51HFihbj9BHLU5DdBKNahKWpnEFFbsYjbut9yU8DR39NfNjGpjb2L88EhhrKcBLT](https://explorer.solana.com/tx/3KxcQDP582a3TZnYdPdyrnMt51HFihbj9BHLU5DdBKNahKWpnEFFbsYjbut9yU8DR39NfNjGpjb2L88EhhrKcBLT?cluster=devnet) |

Баланс до: **5.695481960 SOL**; после: **5.535518320 SOL**.
Расход: **0.159963640 Devnet SOL**, включая **0.000030000 SOL** transaction fees;
остальное — rent созданных аккаунтов. Предварительный бюджет с резервами:
**0.175826440 SOL**; программный предел расходов: **0.5 SOL**.

Один запрос к официальному Devnet faucet на 1 SOL завершился `Internal error`;
пополнение не подтверждено, получено 0 SOL. Повторные запросы не выполнялись.
Имеющегося баланса хватило; средства mainnet и платные API не использовались.

### Проверка без новых транзакций

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault/week11
nvm use
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn verify
yarn read
```

`verify` читает статусы прежних signatures и аккаунты: Devnet genesis, SPL mint,
authority, supply, ATA и расходы, владельца CLMM pool, mint ordering, PDA,
observation/bitmap, ненулевую liquidity, NFT владельца, связь позиции с пулом,
границы ticks и baseline vault. Этот режим не читает private key, не подписывает
и не отправляет транзакции. `read` показывает текущее состояние пула.

Все проверки прошли. Во время чтений возникали HTTP 429; ограниченный backoff
завершился успешно. SDK 0.2.74-alpha имеет проблему `getPoolInfoFromRpc` для
пустого нового пула без tick arrays; перед первой позицией используется официальный
`getSimplePoolInfo` и уже проверенные аккаунты пула. Пакет SDK не модифицировался.

Для ручной проверки Explorer открыть ссылки выше с `cluster=devnet`, проверить
owner пула и personal position (`DRayAU…`), mint/owner/balance NFT ATA, успешный
статус транзакции позиции и SPL inner instructions с двумя взносами и выпуском NFT.
Если Explorer не декодирует CLMM layout, точные ticks/liquidity проверяет `yarn verify`.
**Визуальная проверка страниц Explorer в этой среде не завершена:** подключённый
браузер отсутствовал, HTTP-запрос Explorer вернул 429. Подтверждение on-chain
получено непосредственно через Devnet RPC; это ограничение не скрывается за
утверждением о просмотре Explorer.

### Следующие недели

- **Week 12:** swap через CPI от имени Vault PDA — отдельное согласованное изменение.
- **Week 13:** CLMM-позиция от имени Vault PDA — отдельное изменение владения и учёта.

Перед переводом реальных депозитов vault в CLMM необходимо решить учёт полной
стоимости активов и вывод из стратегии: текущие deposit/withdraw учитывают только
asset ATA. Week 11 эту модель не меняет и миграцию не добавляет.
