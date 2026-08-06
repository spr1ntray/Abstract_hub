# E2E manual checklist

Прогнать перед каждым релизом или после крупных изменений. Запускать на тестовом burner с минимумом энергии (1-2 поинта).

## Pre-flight

- [ ] AGW ETH balance >= 0.001 ETH (для газа — хотя paymaster обычно покрывает, но запас не мешает)
- [ ] `pnpm vault show` — vault unlocks без ошибки
- [ ] Прокси отвечает: `curl -x http://user:pass@host:port https://gigaverse.io/api/marketplace/item/floor/all` возвращает 200 с пустым body или json
- [ ] Burner AGW адрес совпадает с тем что бот распечатает (`pnpm wallet info`)
- [ ] Session cookie свежий — открыть gigaverse.io в браузере, проверить что не разлогинило

## Dry run

- [ ] `pnpm start --dry-run --dungeon 5000` — exits 0, выводит "dry-run" без запросов на gigaverse
- [ ] `pnpm start --dry-run --dungeon underhaul` — то же для dungeonId=3

## Live run

- [ ] `pnpm start --dungeon 5000`
  - [ ] Логи показывают `signer ready` с правильным AGW
  - [ ] Логи показывают `run started`, `move rock`, `move scissor` (чередование)
  - [ ] Логи показывают `loot pick` с боонами из `build.yaml` (приоритет UpgradeRock_ATK)
  - [ ] При окончании энергии — `energy drained — exit`
  - [ ] Sell phase: `sell phase: new items found` если были новые дропы
  - [ ] Каждый листинг — txhash подтверждается в abscan.org
  - [ ] Финальная summary table в стиле cli-table3

## Verify outputs

- [ ] `~/.gigabot/state.db`: новые строки в `listings` со status `submitted` или `skipped` (sqlite3 inspector)
- [ ] Логи (`~/.gigabot/logs/*.jsonl` если включены): ни одной строки не содержит 0x[64-hex chars] или eyJ...
- [ ] Marketplace на gigaverse.io показывает новые листинги по `floor − 1%`

## Failure cases (намеренно)

- [ ] Запустить без session cookie — exit с понятным сообщением "no session cookie"
- [ ] Запустить с просроченным cookie — exit 2 + сообщение "session expired"
- [ ] Перебить wifi на 30 сек посреди run-а — exponential backoff виден в логах, не падает мгновенно
- [ ] Очистить state.db перед прогоном и сразу после — повторный sell phase ничего не должен залистить (idempotency через `alreadyListed`)

## Regression check

- [ ] `pnpm test` — все юниты зелёные
- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
