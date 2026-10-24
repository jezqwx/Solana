# Week 13 — Vault-owned Raydium CLMM position

Только Solana Devnet, Anchor 0.31.1. Используются существующие GUL-A/GUL-B mint и
пул Week 11. Ручная позиция Week 11 и её NFT не передаются Vault и не изменяются.
Программа: `DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9`.

## Аккаунты и блокировка

VaultConfig (145), UserPosition (81), StrategyConfig (138 байт) не расширяются.
Добавлен **ClmmPositionBinding, 146 байт**, PDA `[b"clmm-position", vault.as_ref()]`:
vault, pool, nft_mint, personal_position, tick_lower, tick_upper, open, bump.
Один binding разрешает одну открытую CLMM-позицию для Vault. После закрытия binding
остаётся для проверки состояния и может связать новую позицию с новым NFT mint.

Существующие seeds остаются:

- VaultConfig: `[b"vault", asset_mint.as_ref()]`;
- ShareMint: `[b"share-mint", vault.as_ref()]`;
- UserPosition: `[b"position", vault.as_ref(), user.as_ref()]`;
- StrategyConfig: `[b"strategy", vault.as_ref()]`.

Raydium PersonalPosition PDA — `[b"position", nft_mint.as_ref()]` под CLMM Program.
NFT ATA — стандартный ATA `(Vault PDA, TOKEN_PROGRAM_ID, NFT mint)`. Это отдельный
NFT с decimals=0 и supply=1, не пользовательский ShareMint и не UserPosition.

Переходы mint authority shares:

1. Обычный режим: Vault PDA, deposit/withdraw доступны.
2. Swap-стратегия: Strategy PDA, deposit/withdraw заблокированы.
3. Открытая CLMM-позиция: ClmmPositionBinding PDA. Даже при нулевом GUL-B старый
   `end_strategy` не может вернуть authority: он требует authority=Strategy PDA.
4. Только успешный Raydium close возвращает authority Strategy PDA. Далее нужны
   обратный swap всего GUL-B и проверенный `end_strategy`.

Открытие с нулевой ликвидностью тоже активирует блокировку. Повторный
initialize_strategy не снимает её. Swap Vault во время открытой позиции запрещён;
для генерации комиссий используется отдельный кошелёк. Старые deposit/withdraw,
swap/end_strategy сохраняют прежние списки аккаунтов и pricing. Исторические
счётчики депозитов не уменьшаются.

## Инструкции и CPI

- `open_clmm_position(lower, upper)`: admin оплачивает создание NFT/позиции,
  NFT получает Vault PDA; Raydium open_position_v2 с liquidity=0, base_flag=None,
  metadata=false. Поэтому admin не требуется право переводить токены Vault.
- `increase_clmm_liquidity(liquidity, max_a, max_b)`: Vault подписывает
  increase_liquidity_v2 и вносит оба токена. Проверяются ненулевые расходы,
  лимиты и точное изменение liquidity.
- `collect_clmm_fees(min_a, min_b)`: decrease_liquidity_v2 с liquidity=0 обновляет
  fee growth и перечисляет trading fees в канонические ATA Vault. Ликвидность
  остаётся неизменной; реальные полученные суммы должны удовлетворять minimum.
- `decrease_clmm_liquidity(liquidity, min_a, min_b)`: положительная liquidity,
  не больше позиции и i128::MAX, минимум хотя бы одного токена положителен;
  Raydium проверяет principal minima, Vault дополнительно проверяет изменения.
- `close_clmm_position`: требует нулевую liquidity, fees owed и rewards owed;
  Raydium сжигает NFT и закрывает personal position/NFT ATA. Проверка закрытия
  выполняется до возврата mint authority shares.

NFT mint классического SPL после close **остаётся с supply=0**: закрытие самого
mint поддерживается Raydium для Token-2022, а здесь используется classic SPL.
Rent personal position и NFT ATA возвращается **Vault PDA**, подписавшему close,
а не admin. Новый binding и classic NFT mint сохраняют rent. SOL-рент не является
asset-токеном и не учитывается в цене shares.

Все новые инструкции проверяют admin против VaultConfig, канонические PDA/ATA,
pool owner/ID/mints/vaults, NFT owner/mint/amount, связь personal position, ticks,
tick arrays, bitmap и executable CPI target. Внешние remaining accounts запрещены;
проверенный bitmap/pool добавляются программой. Применяется invoke_signed через
CpiContext с `[b"vault", asset_mint, &[vault.bump]]`. Подпись Position PDA при
восстановлении authority: `[b"clmm-position", vault, &[binding.bump]]`.

Проверки токенов вынесены в отдельную функцию, а pool accounts — в вложенную
Accounts-группу для соблюдения SBF stack 4096 байт. Проверки не отключались.
Все CPI и изменения lock атомарны; ошибки откатывают всю транзакцию.

## Совместимость и диапазон

Официальный CPI crate закреплён на
[5aeec4b](https://github.com/raydium-io/raydium-cpi/tree/5aeec4b40b09c7f42e28a0f697132b76de872856/programs/clmm-cpi).
Сверены инструкции [open](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/open_position_v2.rs),
[decrease/fees](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/decrease_liquidity_v2.rs)
и [close](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/close_position.rs).
PersonalPositionState имеет совместимый Borsh prefix и длину 281 байт: recent_epoch
занял часть старого padding. Tick arrays проверяются по стабильному заголовку,
без десериализации устаревшего внутреннего TickState из CPI adapter.

Позиция использует ticks **[-600,600]**, spacing=60, вокруг исходного tick=-1.
Это примерно 0.941767…–1.061833… GUL-B/GUL-A. Используются уже существующие массивы
ticks со start=-3600 и 0. Новые tick arrays не создаются. Планируемый вклад ограничен
примерно 20 GUL-A и 20 GUL-B; точные raw amounts рассчитывает закреплённый SDK.
Все суммы/ликвидность — BN/BigInt; допуск max/min — 1%. Аккаунты пула с reward
campaigns отклоняются: дополнительные reward recipients здесь не реализованы.

## Команды

WSL, Node 20.19.0, существующий wallet `~/.config/solana/jezqwx/id.json`:

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault
yarn install --frozen-lockfile
yarn --cwd week11 install --frozen-lockfile
yarn --cwd week12 install --frozen-lockfile
yarn --cwd week13 install --frozen-lockfile
cargo fmt --check
anchor build
cargo test -p liquidity_vault --lib
yarn typecheck
yarn --cwd week11 test
yarn --cwd week12 test
yarn --cwd week13 test
cd week13
yarn preflight
yarn read
yarn verify
```

Регрессия Week 8–10 запускается отдельно и **отправляет Devnet-транзакции**:

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=/home/dunan/.config/solana/jezqwx/id.json \
RUN_DEVNET_INTEGRATION=1 \
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/liquidity_vault.ts
```

`preflight` читает Devnet и при первом запуске создаёт локальные ignored keys и
публичный manifest; `read`/`verify` не подписывают и не отправляют транзакции.
`verify` рассчитан на завершённый цикл. Следующие команды **отправляют Devnet-транзакции**:

```bash
yarn open
yarn add
yarn trade
yarn collect
yarn decrease
yarn close
yarn reverse
yarn end
# либо вся последовательность:
yarn run run
```

Open включает deposit, lookup table и подготовительный swap. Trade финансирует
отдельный test wallet только тестовыми SOL/GUL-A, делает прямой и обратный обмен.
End выполняет полный вывод shares и возврат остатка средств test wallet.
Для больших инструкций используется v0 transaction с Address Lookup Table.
Таблица остаётся доступной для повторного использования; её rent не считается
возвращённым. NFT/trader/buffer keypairs и signed bytes находятся только в `.runtime/`.

Манифест фиксирует signature до отправки. При неоднозначном результате клиент
проверяет прежнюю signature и состояние, затем останавливается. Автоматического
переподписания/повторения финансовой операции нет. HTTP-запросы ограничены по
частоте, чтения имеют ограниченный exponential backoff; preflight включён.
Не удалять manifest или lock работающего процесса ради повторной отправки.

## Ограничения

Полноценного NAV нет; пользователь зависит от действий admin и доступности Raydium.
Потери от цены/комиссий отражаются в assets после завершения. Dust GUL-B и donations
могут препятствовать end_strategy; если cleanup не удался, lock должен сохраниться.
Внешнее сжигание shares тоже может оставить несовместимое assets/supply состояние.
Pool/program/ABI закреплены для учебного Devnet сценария; это не универсальная
стратегия и не аудит для production. Week 14 frontend и Week 15 demo не реализуются.

Публичные доказательства и фактические суммы: `manifest.devnet.json` и раздел Week 13
основного README. Отрицательные сценарии — подписанные RPC-симуляции, а не
опубликованные failed-транзакции; Explorer links для них не выдумываются.

## Фактический Devnet результат Week 13

**DONE.** Upgrade и все 17 транзакций цикла проверены с `finalized`, `err=null`.
18 отрицательных сценариев прошли только RPC-симуляцию (`published=false`), без отправки.
Локально: Rust **13/13**, Week 11 **4/4**, Week 12 **2/2**, Week 13 **2/2**;
`cargo fmt --check`, `anchor build`, общий `yarn typecheck` — PASS.
Регрессия Week 8–10: **10/10 Devnet integration tests**. Read-only verify Week 11/12/13 — PASS.

Максимальный размер подписанной транзакции цикла — **732 байта** при лимите 1232;
максимальное фактическое потребление — **133225 CU** (open), бюджет CPI-команд
650000 CU. Сборка не содержит ошибок превышения SBF stack.

### Публичные аккаунты

| Аккаунт | Devnet Explorer |
|---|---|
| Программа | [DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9](https://explorer.solana.com/address/DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9?cluster=devnet) |
| Пул | [gftP6PpRANU2cNY1aRXCGXv2gYjGgLYQLWuw41rbDrf](https://explorer.solana.com/address/gftP6PpRANU2cNY1aRXCGXv2gYjGgLYQLWuw41rbDrf?cluster=devnet) |
| Vault | [8AeUZyL1kxZn3QLcqzL88Ay1i2wjDdui2VyTZHp9Y6fy](https://explorer.solana.com/address/8AeUZyL1kxZn3QLcqzL88Ay1i2wjDdui2VyTZHp9Y6fy?cluster=devnet) |
| Strategy | [3w3pR8guWs2SStpwf2bvkwoFyrNJjdiUSujsC5Jmp8TF](https://explorer.solana.com/address/3w3pR8guWs2SStpwf2bvkwoFyrNJjdiUSujsC5Jmp8TF?cluster=devnet) |
| Binding (146 байт) | [DsWcm72tb7AXmkGqn4tN2eRzLBYU7RwBo3g1Cb2tJ2QR](https://explorer.solana.com/address/DsWcm72tb7AXmkGqn4tN2eRzLBYU7RwBo3g1Cb2tJ2QR?cluster=devnet) |
| CLMM personal position (закрыта) | [6LqQ71xwdd5sF2Md4u4sAnqfsXWFzaTpaKYGyFmp953W](https://explorer.solana.com/address/6LqQ71xwdd5sF2Md4u4sAnqfsXWFzaTpaKYGyFmp953W?cluster=devnet) |
| NFT mint (supply=0) | [VSnJYEPhb5CsLpSukaYy9tWbCwd9cEkKfQ4GXEoirhL](https://explorer.solana.com/address/VSnJYEPhb5CsLpSukaYy9tWbCwd9cEkKfQ4GXEoirhL?cluster=devnet) |
| NFT ATA Vault (закрыт) | [94A4uu14XC9bh16yWaateFnrfRs9pZH8fKjoS3h1SB3G](https://explorer.solana.com/address/94A4uu14XC9bh16yWaateFnrfRs9pZH8fKjoS3h1SB3G?cluster=devnet) |
| GUL-A ATA Vault | [Gi9DMbq37o7bU8ecvh3uHSwy1D8pxBcb9hLgYsg6hrdf](https://explorer.solana.com/address/Gi9DMbq37o7bU8ecvh3uHSwy1D8pxBcb9hLgYsg6hrdf?cluster=devnet) |
| GUL-B ATA Vault | [GabSU6QBJoTFzEqNPBpQFkgvqRCfkLsyAKonNSnouUbm](https://explorer.solana.com/address/GabSU6QBJoTFzEqNPBpQFkgvqRCfkLsyAKonNSnouUbm?cluster=devnet) |
| Отдельный trader (SOL=0) | [EFZqz5vxUjiyqVM2WvT53WQysKy7zeC7cxTrZxoh3S5t](https://explorer.solana.com/address/EFZqz5vxUjiyqVM2WvT53WQysKy7zeC7cxTrZxoh3S5t?cluster=devnet) |
| Address Lookup Table | [HeGPmrnEkpm4yWKT3136w2Eu7nn7EXQw9fx7R1MivAk8](https://explorer.solana.com/address/HeGPmrnEkpm4yWKT3136w2Eu7nn7EXQw9fx7R1MivAk8?cluster=devnet) |

### Подтверждённые транзакции

| Этап | Signature / Explorer Devnet |
|---|---|
| deploy | [26peZLB215wWv5GeSggGMo95ozfA4GXdXChkxrbdCDFkxmvx4XSePnwd2BR4c7ckMiAeSBx32XbMNg3hAC1EnfGn](https://explorer.solana.com/tx/26peZLB215wWv5GeSggGMo95ozfA4GXdXChkxrbdCDFkxmvx4XSePnwd2BR4c7ckMiAeSBx32XbMNg3hAC1EnfGn?cluster=devnet) |
| lookup-create | [tdrTm5SA6vPDDwfQU2RLkJh6CDYiu8hRmrPxJ6o5xVsYJ3WbZJNx4qkq6NMf5JHQiWUp7z4rR4rkavqurVZ8H9Z](https://explorer.solana.com/tx/tdrTm5SA6vPDDwfQU2RLkJh6CDYiu8hRmrPxJ6o5xVsYJ3WbZJNx4qkq6NMf5JHQiWUp7z4rR4rkavqurVZ8H9Z?cluster=devnet) |
| lookup-extend-0 | [4FdiaUaEgy9C1wNdsQJs2qWz9sa5aRfL1oj3StbbgxhbehYvCRcFBkH47pbJjLDnrTG7GUgoDKYLeKLCXhMyR44p](https://explorer.solana.com/tx/4FdiaUaEgy9C1wNdsQJs2qWz9sa5aRfL1oj3StbbgxhbehYvCRcFBkH47pbJjLDnrTG7GUgoDKYLeKLCXhMyR44p?cluster=devnet) |
| lookup-extend-15 | [3tCNpWJXRPhFApaWHUzEeLENF5ayzMfGohcsZknpRNmSSjkEMUuFazD3xavV4vCHQEDxTGWk8wrGUKA8zyP5BgC6](https://explorer.solana.com/tx/3tCNpWJXRPhFApaWHUzEeLENF5ayzMfGohcsZknpRNmSSjkEMUuFazD3xavV4vCHQEDxTGWk8wrGUKA8zyP5BgC6?cluster=devnet) |
| deposit | [5yAp2qrcfoR1SGvgyz44mC1teZyc9WAbtyaGiXjq3epseezAF65dTafRWM4bwqNRMinxMSThAD8Um767CjRVuKW7](https://explorer.solana.com/tx/5yAp2qrcfoR1SGvgyz44mC1teZyc9WAbtyaGiXjq3epseezAF65dTafRWM4bwqNRMinxMSThAD8Um767CjRVuKW7?cluster=devnet) |
| prepare-swap | [3BjtExEAQwo5b1w8Vsrq7gzw6QuxfF5igci65zendf29kSLreXVrHVoxEndZHf5kcfzcA9XrnWNZTR2Eqv5hpA6H](https://explorer.solana.com/tx/3BjtExEAQwo5b1w8Vsrq7gzw6QuxfF5igci65zendf29kSLreXVrHVoxEndZHf5kcfzcA9XrnWNZTR2Eqv5hpA6H?cluster=devnet) |
| open | [miD9So23oiGF6BsQC1TrzLcnDDCNP4wQgynR4Q6HDfRAPT9DQBJeMUPDYBFCbw17pF5S9A9rZiefwhpfvxTefjV](https://explorer.solana.com/tx/miD9So23oiGF6BsQC1TrzLcnDDCNP4wQgynR4Q6HDfRAPT9DQBJeMUPDYBFCbw17pF5S9A9rZiefwhpfvxTefjV?cluster=devnet) |
| add | [3hhMMKriY7UJWMbJXkfFLExWsWNVrMUZ5EDwjxfoJjjbsHUuU3yFKmnSNjVZYuwChvViEy3D9aMWZ3uwA7KqNPdy](https://explorer.solana.com/tx/3hhMMKriY7UJWMbJXkfFLExWsWNVrMUZ5EDwjxfoJjjbsHUuU3yFKmnSNjVZYuwChvViEy3D9aMWZ3uwA7KqNPdy?cluster=devnet) |
| fund-trader | [5FM7HAfmrqEFSEA9qC3HMJTTwsV29dRFJf2uH6WsnudTJ8hSgW5BPMVWb6ttQqXhG7rNJUz2wR2VBeENa1eQuVgG](https://explorer.solana.com/tx/5FM7HAfmrqEFSEA9qC3HMJTTwsV29dRFJf2uH6WsnudTJ8hSgW5BPMVWb6ttQqXhG7rNJUz2wR2VBeENa1eQuVgG?cluster=devnet) |
| trade-forward | [S4KcQVQetbuejP3jqPJRUM4gWpBrtpBvCNhooMyVRdWAtRb7xE5Lroaw9f8Vpi2fFbsb6A2nS5tb2ccrCfS87xN](https://explorer.solana.com/tx/S4KcQVQetbuejP3jqPJRUM4gWpBrtpBvCNhooMyVRdWAtRb7xE5Lroaw9f8Vpi2fFbsb6A2nS5tb2ccrCfS87xN?cluster=devnet) |
| trade-reverse | [5d8LCbLmVvgx9wMWKXkte92fDgLDwkF3tQPFk6mZ1A6S64mX99Bwq9MU7C4mQS6U4Mpb7jrNg7Vnq5EtJojvJFkQ](https://explorer.solana.com/tx/5d8LCbLmVvgx9wMWKXkte92fDgLDwkF3tQPFk6mZ1A6S64mX99Bwq9MU7C4mQS6U4Mpb7jrNg7Vnq5EtJojvJFkQ?cluster=devnet) |
| collect | [sA7B2dNqb7LGxFw4TiMWgXNzuXJYa5DNHLny2UHMsVNPRzuYDMG7u3aXxUzrswbG8x3Pnvjr6n1qordphEkEFMo](https://explorer.solana.com/tx/sA7B2dNqb7LGxFw4TiMWgXNzuXJYa5DNHLny2UHMsVNPRzuYDMG7u3aXxUzrswbG8x3Pnvjr6n1qordphEkEFMo?cluster=devnet) |
| decrease | [2FUc9zbnH6ZNRoHrxcpmkb7fyT4RSbQ7KAK5AcC5EX1mjEd5k1RRJJR2TPyJ6VwaBA8EzVWTk91ZRT377s6zxWF7](https://explorer.solana.com/tx/2FUc9zbnH6ZNRoHrxcpmkb7fyT4RSbQ7KAK5AcC5EX1mjEd5k1RRJJR2TPyJ6VwaBA8EzVWTk91ZRT377s6zxWF7?cluster=devnet) |
| close | [3ZiQs1QKyaGKUvNAuGVrFTtcMRHkWyFgJDNhAEG4oCHaFFG766d13UDWnNZYefDyjh7EzbfXJnfiHaV3TsUwadh2](https://explorer.solana.com/tx/3ZiQs1QKyaGKUvNAuGVrFTtcMRHkWyFgJDNhAEG4oCHaFFG766d13UDWnNZYefDyjh7EzbfXJnfiHaV3TsUwadh2?cluster=devnet) |
| reverse | [2Y4MmBnCoWBnnUQHo5ink8qHj6LnRSf3EerAR3RcBFcfaPWEEc97QznqpaF5ykv1qEfSJ7K4yGQLtmaNxPpABeL7](https://explorer.solana.com/tx/2Y4MmBnCoWBnnUQHo5ink8qHj6LnRSf3EerAR3RcBFcfaPWEEc97QznqpaF5ykv1qEfSJ7K4yGQLtmaNxPpABeL7?cluster=devnet) |
| end | [wJCW4w14oJseNPdWpmGnoN8seyrFXydZn7ceDoRzgCkqJ3iYdJaY69hEQZKuqU15PjR9Pq7M96NihY32Yw1q8RV](https://explorer.solana.com/tx/wJCW4w14oJseNPdWpmGnoN8seyrFXydZn7ceDoRzgCkqJ3iYdJaY69hEQZKuqU15PjR9Pq7M96NihY32Yw1q8RV?cluster=devnet) |
| withdraw | [3fsfKh8Ras2xkfPFywxVX42pSQmVf92eeyDHLPKk3RJ2fwfnARRKnMzKtZRURLoq7X4As31W1Y2VYn5u5VhrgyJj](https://explorer.solana.com/tx/3fsfKh8Ras2xkfPFywxVX42pSQmVf92eeyDHLPKk3RJ2fwfnARRKnMzKtZRURLoq7X4As31W1Y2VYn5u5VhrgyJj?cluster=devnet) |
| refund-trader | [5N2DeqDX7rtk7qHaei42JJWtKT1eFwkwLiFtdZr8FP55anpKVG1H8RbKVPDBzpj82VE2UpXKSgRoenJBceCttqj1](https://explorer.solana.com/tx/5N2DeqDX7rtk7qHaei42JJWtKT1eFwkwLiFtdZr8FP55anpKVG1H8RbKVPDBzpj82VE2UpXKSgRoenJBceCttqj1?cluster=devnet) |

### Балансы и доказательства

Все SPL-суммы ниже отображены с decimals=6; liquidity — целое Raydium u128.

| Состояние | GUL-A в Vault ATA | GUL-B в Vault ATA | Shares supply | Liquidity позиции |
|---|---:|---:|---:|---:|
| До цикла | 0.000000 | 0.000000 | 0.000000 | 0 |
| Открыта | 50.000000 | 49.758685 | 100.000000 | 0 |
| После add | 30.000000 | 32.687120 | 100.000000 | 627146682 |
| После collect | 30.000599 | 32.687715 | 100.000000 | 627146682 |
| После decrease | 50.001310 | 49.758570 | 100.000000 | 0 |
| Перед withdraw | 99.751909 | 0.000000 | 100.000000 | 0 |
| После withdraw | 0.000000 | 0.000000 | 0.000000 | 0 |

Внесено 20.000000 GUL-A + 17.071565 GUL-B, liquidity=627146682.
После двух реальных обменов отдельного trader начислено и собрано **0.000599 GUL-A + 0.000595 GUL-B**.
Начисление вычислено по on-chain fee growth пула/ticks/позиции и точно совпало
с фактическими изменениями ATA при collect; liquidity не изменилась.
Decrease вернул **20.000711 GUL-A + 17.070855 GUL-B**.
Пользователь после unlock вывел **99.751909 GUL-A** из депозита 100 GUL-A.
Разница — результат обменов, цены и комиссий; обещания прибыли нет.

В открытом состоянии NFT ATA `94A4uu14XC9bh16yWaateFnrfRs9pZH8fKjoS3h1SB3G` имел authority=Vault
`8AeUZyL1kxZn3QLcqzL88Ay1i2wjDdui2VyTZHp9Y6fy`, amount=1. После close personal position/NFT ATA
отсутствуют, NFT mint supply=0, binding.open=false. После reverse GUL-B=0; после end
share mint authority=Vault и StrategyConfig.active=false. Исторические счётчики
VaultConfig/UserPosition равны **201 GUL-A** и не уменьшены выводом.

Ручная позиция Week 11, её NFT и ATA совпали с исходными hashes. Сохранённая
база из 136 старых аккаунтов не изменилась. Остатки trader возвращены, его ATA
закрыты и SOL=0. Regression tests используют отдельные новые тестовые mint.

В Explorer: открыть collect → Instructions → Liquidity Vault → inner Raydium
`decrease_liquidity_v2` → SPL Token transfers. Для close проверить burn/close;
для withdraw — SPL burn shares и transfer_checked assets. Успех inner CPI также
проверен через RPC transaction metadata; визуальный просмотр Explorer не подменяется
этой проверкой. Закрытые аккаунты могут не отображать текущее состояние — смотреть
исторические транзакции open/add/close.

### SOL, rent и RPC

- Исходный wallet: **4.626456160 SOL**.
- После upgrade: **3.543600320 SOL**.
- После цикла Week 13: **3.532156600 SOL**.
- После регрессии: **3.379394280 SOL**.
- Дополнительный rent ProgramData: **1.079235840 SOL**.
- Fees upgrade/upload суммарно: **0.003620000 SOL**.
- Fees 17 транзакций цикла (оба payer): **0.000095000 SOL**.
- Rent close, зачисленный Vault PDA: **0.003566160 SOL**.
- Расход wallet на регрессию (rent + fees): **0.152762320 SOL**.

Upload buffer закрыт и rent возвращён. Fees deploy/upload вычислены как разница
wallet до upgrade и до первой операции цикла за вычетом роста rent ProgramData;
между этими точками другие операции не выполнялись. Fees цикла взяты из metadata.

| Сохранённый аккаунт | Lamports | Размер |
|---|---:|---:|
| binding | 1391920 | 146 |
| nftMint | 1066800 | 82 |
| lookupTable | 5323840 | 920 |
| vault | 4953000 | 145 |

Rent, вернувшийся Vault, не возвращён admin и не включён в стоимость shares.
Rent Binding/NFT mint/ALT остаётся в соответствующих аккаунтах.
Развёрнутый бинарник совпадает с локальным SHA-256 `1ab854c3d93f8aea5cb940c2c4b624b5cb444565b4d2b137fcd1edd7c573a4f5`.
Program ID, program keypair, кошелёк и конфигурация не заменены.

В цикле Week 13 не было HTTP 429 или неоднозначных отправок. Использованы paced
reads, ограниченный backoff и подтверждение по прежней signature. Никаких blind
resends или отключения preflight. В старой регрессии встречались HTTP/WebSocket
429, однако все 10 тестов завершились успешно без повторного запуска набора.
Результаты и RPC-события сохранены в `.runtime/regression.log`; его SHA-256 и
число сообщений 429 записаны в публичном `finalAudit.regression`.
