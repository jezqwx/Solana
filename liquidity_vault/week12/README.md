# Week 12 — Raydium CLMM swap CPI

Anchor 0.31.1; только Devnet. Используются mint и пул из
`../week11/manifest.devnet.json`. Новые CLMM-пулы и NFT-позиции не создаются.
`manifest.devnet.json` содержит отдельный тестовый vault, signatures, реальные
состояния до/после, котировки и логи отрицательных проверок.

## Архитектура

Новые инструкции:

- `initialize_strategy`: только admin, проверенный пул Week 11, StrategyConfig и
  второе ATA с authority=Vault PDA. Повторный вызов не сбрасывает lock или bindings.
- `swap(amount: u64, min_amount_out: u64, a_to_b: bool)`: только admin, положительные
  amount/minimum, exact-input CPI `swap_v2`. Прямое направление — основной ATA →
  quote ATA; обратное — quote ATA → основной ATA. Все средства остаются у Vault PDA.
- `end_strategy`: восстановление обычного режима после проверки реальных остатков.

Новый PDA StrategyConfig: `[b"strategy", vault.key().as_ref()]`, **138 байт** с
discriminator. Поля: vault, pool, quote_mint, quote_vault, active, bump.
Второе хранилище — стандартный ATA `(Vault PDA, TOKEN_PROGRAM_ID, GUL-B mint)`.
VaultConfig **145 байт**, UserPosition **81 байт**, прежние seeds и Program ID
сохранены. Realloc и миграции старого состояния нет.

| Аккаунт | Seeds / связь | Полномочия |
| --- | --- | --- |
| VaultConfig | `[b"vault", asset_mint.as_ref()]` | PDA программы Vault; admin управляет стратегией |
| ShareMint | `[b"share-mint", vault.as_ref()]` | Mint authority: Vault PDA в обычном режиме, Strategy PDA во время стратегии |
| UserPosition | `[b"position", vault.as_ref(), user.as_ref()]` | Прежняя карточка исторических депозитов |
| StrategyConfig | `[b"strategy", vault.as_ref()]` | Программа Vault, привязка к единственному pool/quote mint/quote ATA |
| Основное и второе ATA | `[vault.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()]` под Associated Token Program | Solana owner: SPL Token Program; token authority: Vault PDA |
| CLMM pool/config/observation/tick arrays/bitmap | Проверенные аккаунты Raydium и связи с pool | Solana owner: официальный Raydium CLMM Devnet Program |
| CLMM pool vaults | Адреса из PoolState, mint и authority=pool | Solana owner: SPL Token Program |

Admin подписывает внешнюю инструкцию Liquidity Vault; программа добавляет подпись
Vault PDA при CPI Raydium, который вызывает SPL Token Program для переводов.
Admin не обладает подписью Vault PDA и не получает полномочия прямого SPL transfer
со второго ATA. CPI AccountInfo для Token-2022 и Memo передаются согласно ABI swap_v2;
обе пары mint/account в этой реализации остаются классическими SPL Token.

### Блокировка shares без изменения ABI старых инструкций

Старые deposit/withdraw уже обязаны проверять mint authority share mint.
При первом swap authority атомарно передаётся **с Vault PDA на Strategy PDA**,
устанавливается `active=true`. Обе старые инструкции теперь возвращают явный
`StrategyActive`, пока authority отличается от Vault PDA. Пропуск optional account
или подмена стратегии не позволяют обойти lock: новых аккаунтов в deposit/withdraw
не добавлено, проверяется обязательный канонический share mint.

Если Raydium CPI завершается ошибкой, смена authority и active откатываются вместе
с переводами. После успешного обратного swap lock остаётся активным до
`end_strategy`. Эта инструкция требует:

- канонический quote ATA с **amount=0**;
- основной asset balance и supply shares одновременно нулевые либо оба ненулевые;
- согласованность active и текущей share mint authority.

Только после этого Strategy PDA подписывает возврат mint authority Vault PDA.
Admin не может снять lock декларацией или подставить пустое чужое ATA.
Исторические total_deposited/deposited_amount не переоцениваются и не уменьшаются.

Это **не NAV-модель**: вывод во время стратегии запрещён, пользователь зависит от
завершения стратегии администратором. Комиссии и убытки после возврата отражаются
в текущем основном балансе и стоимости shares. Прямые SPL transfer/burn shares
остаются возможны; внешнее сжигание всех shares при оставшихся активах создаёт
известное состояние A>0/S=0, которое автоматически не разблокируется. Donation
во второе ATA может задержать завершение — даже dust требуется обменять обратно.
Незапрошенные donations quote-токена в неактивном режиме не считаются NAV; ни одна
инструкция не перемещает основной актив в стратегию без атомарной блокировки.

### Проверки CPI и версии

Официальный `raydium-clmm-cpi`, ревизия
`5aeec4b40b09c7f42e28a0f697132b76de872856`, feature `devnet`:
<https://github.com/raydium-io/raydium-cpi/tree/5aeec4b40b09c7f42e28a0f697132b76de872856/programs/clmm-cpi>.
SDK `@raydium-io/raydium-sdk-v2@0.2.74-alpha`, Web3.js 1.98.4, Anchor client 0.31.1.
Пакеты закреплены отдельным yarn.lock.

Проверяются официальный исполняемый CLMM program ID, owner/discriminator пула,
пул Week 11, оба mint, pool vaults, amm config, observation, стандартные token
programs и PDA/authority обоих ATA. Все remaining tick arrays/bitmap проверяются
по owner, discriminator, длине, pool ID, PDA и отсутствию дубликатов. Разрешено
не более десяти remaining accounts; порядок для направления проверяет Raydium.

У ветки CPI 0.31.1 старый внутренний layout ObservationState. Для CPI нужны только
AccountInfo, поэтому adapter используется для кодирования вызова, а observation
проверяется по актуальному заголовку: 4483 байта, discriminator и pool ID по offset
19. Tick arrays проверяются по стабильному заголовку, не по устаревшим внутренним
TickState. В PoolState читаются проверенные неизменные поля начального префикса.
Изменение upstream ABI/размеров должно приводить к отказу проверки и новому ревью.

Vault подписывает CPI seeds `[b"vault", asset_mint.as_ref(), &[vault.bump]]`.
Raydium выполняет SPL Token CPI внутри внешней инструкции Liquidity Vault.
После CPI token accounts перечитываются; exact input и min output проверяются
через checked subtraction. Частичное исполнение не принимается.

## Клиент, quote, отправка

Официальный SDK `getSwapPoolInfo` + `swapInternal` получает живой пул и tick arrays.
Raw amounts — BN/целые строки. `min_out = floor(expected_out * 9900 / 10000)`;
нулевой minimum запрещён. Перед каждой фактической отправкой берётся новая
котировка; клиент отклоняет quote старше 90 секунд. On-chain minimum защищает от
изменения цены после quote. Decimal применяется только к отображению цены.

Транспорт использует свежий confirmed blockhash, sigVerify-симуляцию, preflight,
`maxRetries=0`, minContextSlot и подтверждение err=null. Signature сохраняется
до broadcast. При ошибке подтверждения проверяется прежняя signature с
`searchTransactionHistory=true`; при неопределённости читается snapshot и
выполнение останавливается. Новая подпись/повтор финансовой операции не создаются.
Read-only HTTP 429/502/503/504 и сетевые сбои имеют ограниченный backoff с jitter.
Клиент также последовательно планирует HTTP-запросы с интервалом не менее 1.1 секунды,
чтобы уменьшить число одновременных соединений и всплески запросов на public RPC.
Автоматического восстановления неизвестной финансовой операции нет. В ходе проверки
одна отправка получила HTTP 429: перед новой попыткой отдельно проверены отсутствие
signature в истории, отсутствие транзакции, **finalized block height выше срока
blockhash** и совпадение всех финализированных аккаунтов со снимком до отправки.
Только после этих доказательств неисполненная попытка вручную перенесена в
`expiredAttempts` манифеста. Простого `status=null` для такого решения недостаточно.
`.runtime/` содержит только локальные recovery-артефакты и исключена из Git;
wallet JSON не копируется, ключ программы не заменяется.

**Slippage rejection:** с включённым preflight заведомо неверный minimum отклоняется
до публикации. Записанная signature подписанной симуляции имеет `published=false`;
это не on-chain транзакция и у неё нет достоверной Explorer transaction page.
Отсутствие RPC-ответа не засчитывается как slippage. Проверяются конкретный
`TooLittleOutputReceived`, вызов Raydium и неизменность всех snapshots.

## Команды

В WSL, Node 20.19.0:

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault
cargo fmt --check
anchor build
cargo test -p liquidity_vault --lib
yarn typecheck
cd week12
yarn install --frozen-lockfile
yarn test
yarn quote
yarn verify
```

`quote` и `verify` не отправляют транзакций. `verify` ожидает завершённый цикл
демонстрации: quote/base ATA и shares supply нулевые, authority восстановлена,
исторические депозиты 101 GUL-A. Root `yarn typecheck` проверяет старые тесты и
изолированные клиенты Week 11/12 отдельно: смешивание их разных Web3.js в одном
TypeScript compilation вызывает конфликт приватных типов.

Первоначальная подготовка `yarn check:env` создаёт манифест только если test vault
ещё отсутствует. **`yarn run run` отправляет Devnet-транзакции** и выполняет сценарии;
повторные успешные этапы распознаются по сохранённым signatures. Не удалять журнал
ради повторного теста и не снимать `.runtime/command.lock`, пока процесс работает.

Отрицательные сценарии: чужой admin, неверные pool/mint/источник/получатель/CPI
target/pool vault/observation/tick array, нулевые amount/minimum, нехватка средств,
slippage до и после активации, запрет deposit/withdraw и преждевременного unlock.
Положительные проверки: второе ATA, swap и PDA подпись/inner instructions,
неизменность supply, изменение цены, идемпотентность init, reverse, unlock,
возобновление deposit и полный withdraw. Старые десять тестов не удалены.

Week 11 сохраняет точную проверку wallet balance: она дополнительно учитывает
только подтверждённые pre/post token balances депозитов/вывода Week 12. Original
manifest и baseline Week 11 не переписываются; supply, authority, позиция, диапазон
и остальные проверки сохранены.

Week 13: позиция от имени Vault, управление ликвидностью и получение комиссий.
Эти операции в Week 12 не добавлены.
