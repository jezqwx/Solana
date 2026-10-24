# Week 11: собственный Raydium CLMM-пул в Devnet

Изолированный клиент кошелька. Код Liquidity Vault, его PDA, данные и программа
не участвуют в создании пула/позиции. Week 12 (swap CPI vault) и Week 13
(позиция vault) здесь не реализованы.

## Воспроизведение

В WSL, Node **20.19.0**, Yarn **1.22.22**:

```bash
cd /mnt/d/MySelf/Projects/ForGulya/Solana/liquidity_vault/week11
nvm use
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn verify
yarn read
```

`test` выполняет локальные тесты без RPC. `verify` и `read` выполняют только
чтение Devnet, не читают private key и не создают новые аккаунты или транзакции.
Нельзя удалять или заменять `manifest.devnet.json`: он связывает повторный запуск
с уже выполненными операциями. `vault-baseline.devnet.json` содержит только
публичные адреса и хеши состояния существующих аккаунтов Week 8–10.

## Этапы создания

Следующие команды предназначены для первоначального выполнения и восстановления
того же запуска. `faucet`, `tokens`, `pool`, `position` могут отправлять Devnet
транзакции; это не команды проверки.

```bash
yarn check:env
yarn faucet
yarn tokens
yarn pool
yarn position
```

`check` проверяет genesis hash, официальный исполняемый CLMM, кошелёк,
конфигурацию комиссии и rent. Создаёт исходный снимок vault только при отсутствии
манифеста. Повторный check сравнивает существующий снимок, не подменяя baseline.
Перед каждым отправлением повторно проверяются сеть и снимок.

GUL-A/GUL-B — локальные метки собственных классических SPL mint, **не on-chain
metadata** и не настоящие рыночные активы. Decimals 6, эмиссия по 1 000 000,
mint authority — существующий кошелёк, freeze authority отсутствует.
Публичные ключи сортируются по байтам: GUL-A = token0, GUL-B = token1.
Начальная цена token1/token0 — 1; sqrtPriceX64 = 2^64.

Конфигурация 0: комиссия 0,25%, tick spacing 60. Диапазон около [0,9; 1,1]
округляется наружу до кратных spacing ticks. Это наглядный учебный диапазон
вокруг начальной цены; он требует оба токена и показывает концентрированную
ликвидность. Он не является торговой рекомендацией или гарантией дохода.
Вне диапазона позиция перестаёт предоставлять активную ликвидность.

Для позиции задаётся около 1000 token0; SDK рассчитывает liquidity и второй
токен, максимальные расходы ограничены 1% запасом. Используется классический
NFT без Metaplex metadata (`nft2022=false`, `withMetadata=no-create`).
Владелец NFT — кошелёк, не Vault PDA. Реальные взносы читаются из pre/post
token balances подтверждённой транзакции, а не из клиентской оценки.

## Надёжность и восстановление

- Подпись и ожидаемые публичные аккаунты записываются до broadcast.
- Сгенерированные private keys mint/NFT существуют только в памяти.
- Подписанные bytes для диагностики хранятся в игнорируемой `.runtime/`;
  private keys туда не записываются. Эти bytes не публиковать и не отправлять
  вручную без выяснения статуса.
- Симуляция проверяет подписи и тот же blockhash. Затем `sendRawTransaction`
  использует preflight, `confirmed`, `maxRetries=0`.
- При ошибке проверяется прежняя signature с `searchTransactionHistory=true`.
  При неизвестном/ошибочном статусе дополнительно читаются ожидаемые аккаунты,
  и выполнение останавливается. Новый blockhash и повторная отправка не выполняются.
- Чтения повторяются не более четырёх попыток с exponential backoff и jitter;
  send и faucet не повторяются автоматически.
- Повторная команда с уже подтверждённой signature проверяет состояние без
  новой отправки. Наличие аккаунта само по себе не подменяет подтверждение успеха.
- При блокировке `.runtime/command.lock` сначала проверить, завершён ли указанный
  процесс. После проверки signature и аккаунтов можно вручную удалить только
  этот lock и повторить тот же этап. Манифест, baseline и журнал не удалять.
- Если подтверждённая позиция создана, но RPC ещё не вернул metadata, повторить
  `yarn position`: команда сверит прежнюю signature и восстановит учёт взносов.

Предел расходов — 0,5 Devnet SOL, включая rent/fees. Бюджет рассчитывается через
RPC по размерам SDK; содержит резерв для legacy protocol position/metadata,
которые могут фактически не создаваться. Перед broadcast дополнительно
проверяется расход кошелька из симуляции. Приоритетные tips не используются.

## Официальные источники и закрепление

- [SDK V2](https://github.com/raydium-io/raydium-sdk-V2), npm **0.2.74-alpha**;
  просмотренный source commit `e2e8bcd865189c994682a9477ec8eaf1e2da8aaf`.
- [SDK V2 demo](https://github.com/raydium-io/raydium-sdk-V2-demo/tree/003d9045830033e5ef4178d6db129d83f93e1c7f),
  commit `003d9045830033e5ef4178d6db129d83f93e1c7f`:
  `src/clmm/createPool.ts`, `createPositionFromLiquidity.ts`, `createPosition.ts`.
- [Официальные program IDs](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/common/programId.ts).
- [CLMM create_pool](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/create_pool.rs).

Скрипты адаптируют последовательность официального demo: SDK строит инструкции,
наш transport сохраняет подписанный blockhash и журналирует отправку. Ключи из
примеров не используются; существующий wallet JSON читается только в памяти.
Web3.js закреплён на **1.98.4**, включая транзитивные зависимости, чтобы исключить
конфликт типов двух копий Web3.js. Полный граф фиксируется отдельным yarn.lock.

После Week 13 `verify` дополнительно учитывает реальные движения тестовых токенов
в deposit/withdraw и fund/refund отдельного кошелька из подтверждённых transaction
metadata, включая адреса v0 lookup tables. Исходный manifest и baseline не меняются.
Ручная позиция Week 11 и её NFT проверяются отдельно от новой Vault-owned позиции.
