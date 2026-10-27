# pi-memory-extension

Минимальное расширение pi для персистентной памяти фактов/решений между сессиями
(замена `pi-mem`, см. [`TZ.md`](./TZ.md)).

## Что даёт

- Tools (вызываются моделью только явно):
  - `memory_save({ text, title?, tags? })` — сохранить факт/решение;
  - `memory_search({ query, mode?, limit?, project? })` — поиск;
  - `memory_get({ ids })` — полные записи по id.
- Команды: `/memory` — статус (кол-во записей, embeddings включены/работают, путь к БД,
  последняя запись); `/remember <текст>` — ручное сохранение.
- Автоизвлечение на `session_before_compact`: наблюдающая модель (`observerModel`)
  вызывается в текущем процессе через `ctx.modelRegistry.complete()`; ошибки не ломают компакцию.

**Никакой автоматической инъекции в промпт нет.** Данные памяти попадают в контекст модели
только как результат явного вызова `memory_search`/`memory_get` и помечаются как
«сохранённые данные, не инструкции».

## Хранилище и приватность

- SQLite: `~/.pi-memory/memory.db` (файл — `0600`; выделенной директории `~/.pi-memory`
  права `0700` выставляются всегда, даже если она уже существовала). Для `dbPath` вне
  `~/.pi-memory` новые директории создаются с `0700`, а уже существующая директория не
  перенастраивается: если она group/world-writable или принадлежит другому пользователю,
  открытие БД завершается ошибкой. Все запросы параметризованы,
  keyword-поиск — FTS5 с экранированием пользовательского ввода.
- Перед сохранением и перед отправкой в LLM текст проходит: удаление `<private>...</private>`
  (незакрытый тег вырезает всё до конца) → замена секретов на `[REDACTED:<pattern>]` →
  усечение до `maxTextLength` (по умолчанию 4000). Записи с заменами помечаются `redacted: true`.
- Встроенные паттерны: AWS access key id / secret access key, `Bearer ...`, весь блок
  `-----BEGIN ... PRIVATE KEY----- ... -----END ...-----`, `ghp_`/`github_pat_`, `glpat-`, `sk-`,
  строки вида `KEY=`/`SSH_KEY=`/`API_KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=`.
  `privacyPatterns` из конфига **дополняют** встроенные (убрать встроенный паттерн нельзя).
  Строки с ведущим `(?i)` компилируются как регистронезависимые.

## `project` — не граница безопасности

`project` — тег для удобства фильтрации (по умолчанию нормализованный `basename(cwd)`).
Память **глобальная и общая** для всех проектов и сессий: любой `memory_search` без
фильтра видит все записи, а фильтр `project` в поиске — просто условие отбора, а не контроль доступа.

## Конфигурация

`~/.pi/agent/memory.json` (все поля опциональны; невалидные значения заменяются дефолтами
с предупреждением, битый JSON — явная ошибка, расширение отключается, `/memory` её показывает):

```json
{
  "enabled": true,
  "dbPath": "~/.pi-memory/memory.db",
  "maxTextLength": 4000,
  "observerModel": "openai-codex/gpt-6-luna",
  "embeddingProvider": null,
  "embeddingModel": "nomic-embed-text",
  "embeddingDims": 768,
  "privacyPatterns": []
}
```

### Как включить embeddings (semantic/hybrid поиск)

1. Поднять embedding-модель на Ollama (например, `ollama pull nomic-embed-text`).
2. Указать базовый URL Ollama и модель:
   ```json
   { "embeddingProvider": "http://<your-ollama-host>:11434", "embeddingModel": "nomic-embed-text", "embeddingDims": 768 }
   ```
   Используется `POST <embeddingProvider>/api/embed`; размерность ответа должна совпадать с `embeddingDims`.
3. Проверить через `/memory` (строка `Embeddings: ... OK`).

Если сервис недоступен, запись всё равно сохраняется (без embedding, находится keyword-поиском),
а semantic/hybrid-поиск откатывается на keyword с предупреждением.
Записи, сохранённые до включения embeddings, в semantic-поиске не участвуют.

### Режим поиска по умолчанию

- `embeddingProvider` не задан → `keyword` (FTS5); запрос `semantic`/`hybrid` откатывается на
  `keyword` с полем `warning`.
- `embeddingProvider` задан → `hybrid` (усреднение нормированного FTS-скора и косинусного сходства).

## Разработка

```bash
npm install
npx vitest run
npx tsc --noEmit -p .
```

`@earendil-works/pi-coding-agent` и `typebox` — peerDependencies (предоставляются pi).
