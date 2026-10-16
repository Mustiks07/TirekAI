# API v1

## Интерфейс TirekAI — 16.10.2026

Редизайн T005/T052 не меняет контракты API. Финансовые операции, версии, идемпотентность и области доступа сохранены. Пороги запаса открываются в «Каталог и склад», банковские выписки — на вкладке «Выписки» раздела «Финансы», начальная настройка — в раскрытии на «Сегодня». Разделение оплаты и исполнения, неизвестная себестоимость и источники расчётов сохраняются. Заполнение тестового бизнеса выполняется локальной командой `db:seed:business` через существующие сервисы; нового публичного API заполнения нет.

Все ответы публичного API: `{ data, requestId }` или `{ error: { code, requestId } }`. Кэширование отключено. Мутации требуют JSON и точный Origin из APP_ORIGIN, вход ограничен 16 KiB (POST imports: 512 KiB JSON, содержимое файла отдельно ограничено 256 KiB). Ошибки схемы возвращают `400 INVALID_INPUT`. Неизвестный маршрут возвращает 404.

| Метод | Путь после /api/v1 | Контракт |
| --- | --- | --- |
| GET | session | user/null, доступные organizations, localPreview |
| POST | auth/register | name, email, password; только локальная тестовая регистрация |
| POST | auth/login | email, password; HttpOnly session cookie |
| POST | auth/logout | отзывает серверную сессию, удаляет cookie |
| POST | organizations | name, profile, timezone; создаёт synthetic организацию |
| GET | organizations/:id | organization, branches, разрешённые members/invitations/activity и capabilities UI |
| PATCH | organizations/:id | name, profile, timezone; только owner |
| POST | organizations/:id/branches | name; только owner |
| POST | organizations/:id/invitations | email, role, branchId/null; только owner; возвращает token один раз |
| POST | invitations/accept | token; совпадающий email текущей сессии |
| DELETE | organizations/:id/invitations/:invitationId | отзыв, только owner |
| DELETE | organizations/:id/members/:memberId | исключение не-owner и отзыв сессий, только owner |
| GET | contracts/imports | JSON Schema, версия 1.1; генерируется из Zod |
| GET | organizations/:id/customers | items + pagination; page/limit/branchId |
| PATCH | organizations/:id/customers/:customerId | name,email,phone,version; конфликт версии — 409 |
| POST | organizations/:id/imports | branchId,filename,content,delimiter; предпросмотр, без записи клиентов |
| GET | organizations/:id/imports | items + pagination + workerAvailable; page/limit/branchId |
| GET | organizations/:id/imports/:batchId | batch,rows,pagination,workerAvailable; page/limit |
| POST | organizations/:id/imports/:batchId/confirm | version; только готовые строки, повтор возвращает текущий результат |
| POST | organizations/:id/imports/:batchId/retry | version; только failed/cancelled, новый инициатор |

Клиенты/импорты доступны owner, manager, sales в области membership. Каждый запрос проверяет права заново. query page: 1..100000, limit: 1..100 (по умолчанию 25). Ответы новых списков и предпросмотра проверяются Zod после сериализации дат; ошибочный серверный ответ — 500 RESPONSE_CONTRACT_ERROR. Схемы: `src/domain/import-contracts.ts`. Ограничения refine, невыразимые JSON Schema (например, email или phone обязателен), дополнительно проверяются сервером.

Ошибки импорта: 413 TOO_LARGE, 422 CSV_ENCODING/CSV_HEADERS/CSV_SYNTAX/CSV_EMPTY/CSV_TOO_MANY_ROWS; 409 VERSION_CONFLICT/IMPORT_NO_ROWS/IMPORT_NOT_RETRYABLE. Ошибки конкретных строк входят в errors предпросмотра. Выходные строки содержат только разрешённый пакет, исходный текст файла отдельным API не отдаётся.

Схемы прежних команд: `src/domain/contracts.ts`. Полный OpenAPI и validation прежних ответов остаются в T002. В истории максимум 30 событий, в invites максимум 50 записей. Пагинация полного журнала ещё не реализована. Команда и филиалы пока без пагинации; нагрузочный сценарий не принят.

`POST /api/internal/worker` — отдельный локальный технический мост, не пользовательский API. Принимает только временный bearer supervisor, возвращает `{worked}`; без валидного секрета или вне LOCAL_PREVIEW+LOCAL_DATABASE возвращает 404. Секрет не задаётся в клиенте/файлах и не выводится в лог.

## Каталог и склад: контракты 1.2

Все пути ниже после `/api/v1`. Вход/выход проверяются Zod из `src/domain/inventory.ts`, общий HTTP-конверт/Origin/лимит JSON 16 KiB сохраняются.

| Метод | Путь | Содержание |
| --- | --- | --- |
| GET | contracts/inventory | Сгенерированные JSON Schema |
| GET | organizations/:id/catalog | q/page/limit; позиции + pagination + capabilities |
| POST | organizations/:id/catalog | SKU, RU/KK, category/variant/barcode, goods/service, base_unit/conversions, purchase_price/sale_price, active |
| PATCH | organizations/:id/catalog/:itemId | Полный набор полей + version; конфликт 409 |
| GET | organizations/:id/warehouses | Опциональный branchId, только разрешённые склады |
| POST | organizations/:id/warehouses | branchId/name |
| GET | organizations/:id/inventory/balances | warehouseId/page/limit; physical/reserved/available/value/version |
| GET | organizations/:id/inventory/balance | warehouseId/itemId; quantity/version, в том числе нулевой снимок |
| GET | organizations/:id/inventory/movements | warehouseId/page/limit; журнал, source_id/transfer_id |
| GET | organizations/:id/inventory/reservations | warehouseId/page/limit; active/released/fulfilled |
| GET | organizations/:id/inventory/transfers | warehouseId/page/limit; in_transit/received |
| POST | organizations/:id/stock-commands | key UUID, warehouseId/itemId, kind, note и поля операции |

Команды: receipt(quantity/unit/unitCost), issue(quantity/unit/reservationId?), reserve(quantity/unit), release(reservationId), dispatch(quantity/unit/destinationId), receive(transferId), count(quantity/unit/version/unitCost?), return(quantity/unit/movementId). Receipt unitCost — за выбранную единицу; count unitCost — за базовую единицу излишка. Количества/цены и суммы ответа передаются строками, не JSON float. Время задаётся сервером. Возврат/приёмка перемещения/снятие резерва разрешены для архивной позиции, новые движения — нет.

Sales имеет чтение каталога/остатков, issue/reserve/release/return; без purchase_price и value_minor в ответах. Owner/manager/purchasing имеют write/cost, finance — read/cost, observer — read без стоимости. Филиальная роль не может изменять общий каталог; каждый склад и обе стороны перемещения проверяются сервером. Employee пока не имеет складских прав.

Ошибки: 409 ITEM_EXISTS/VERSION_CONFLICT/UNIT_LOCKED/INSUFFICIENT_STOCK/RESERVATION_MISMATCH/TRANSFER_STATE/RETURN_EXCEEDS/COUNT_BELOW_RESERVED/IDEMPOTENCY_CONFLICT; 422 UNIT_NOT_ALLOWED/QUANTITY_PRECISION/SERVICE_NO_STOCK/SAME_WAREHOUSE/COUNT_COST_REQUIRED/STOCK_LIMIT. Повторная корректная команда возвращает `{id,kind,reused:true}`. Недопустимая команда не сохраняет частичных изменений.


## Заказы и финансы: контракты 1.3

`GET /api/v1/contracts/commerce` публикует схемы из `src/domain/commerce.ts`. Выходы всех новых HTTP-методов проверяются Zod. Денежные суммы ответа — строковые целые тиыны; ввод цены до 6 знаков после точки, ввод фактической оплаты до 2. Все POST используют key UUID, хеш нормализованного запроса и возвращают `{id,reused}`. Ошибка откатывает всю транзакцию. Права повторно проверяются даже при повторе ключа.

Пути ниже после `/api/v1/organizations/:id`:

| Метод | Путь | Поля / результат |
| --- | --- | --- |
| GET | order-customers | branchId/q/page/limit; id/name клиентов для выбора |
| GET | orders | branchId/q/page/limit; суммы, долги, состояние и версия |
| POST | orders | key/branchId/customerId/warehouseId/dueDate/delivery/note/taxMode=excluded; lines[1..30]: itemId/quantity/unit/price/discount |
| GET | orders/:orderId | order, lines, events, eventPagination; page/limit управляют историей |
| POST | orders/:orderId/commands | key/version/note/kind; confirm, cancel, fulfill(lineId/quantity/serviceCost?), return(eventId/quantity) |
| GET | finance/accounts | branchId; счета с фактическими балансами |
| POST | finance/accounts | key/branchId/name/opening; начальный баланс отдельной записью журнала, максимум 100 счетов |
| GET | finance/ledger | branchId/q/page/limit; записи с order_id/obligation_id |
| GET | finance/obligations | branchId/q/page/limit; поставщик, срок, сумма/оплата |
| POST | finance/obligations | key/branchId/supplier/amount/dueDate/note |
| POST | finance/commands | key/accountId/amount/note/kind; детали ниже |
| GET | finance/summary | branchId; сводка за весь период, отдельные revenue/cost/cash/debt/profit/margin/markup и признаки неполноты |
| GET | finance/calendar | branchId/days(1..365)/delayDays(0..365)/expensePercent(0..300); база/сценарий по дням и исходные документы, максимум 5000 |

Денежные команды: payment/refund требуют orderId; supplier_payment — obligationId; income/expense — category/counterparty; expense дополнительно operating boolean; transfer — destinationId. Все суммы положительны, направление задаёт kind. Счёт оплаты и документ должны быть одного филиала. Переводы между филиалами доступны только роли с областью обоих счетов. Связанные заказы/обязательства нельзя подменить чужими ID.

Заказы: owner/manager/sales читают и изменяют; finance/observer только читают. Финансы: owner/manager/finance читают и изменяют. Sales/observer не получают cost_minor в событиях заказа; финансовые API им недоступны. Цена продажи доступна в заказе. Отдельные старые складские команды для заказных резервов/выдач отклоняются ORDER_OPERATION_REQUIRED.

Состояния: draft → confirmed → partial → fulfilled; draft/confirmed/partial → cancelled. Возврат — отдельное событие, не стирает исполнение. Строки после создания не редактируются: ошибочный черновик отменяют и создают новый. delivery/pickup — выбранный ручной способ исполнения, без подключения службы доставки. serviceCost — стоимость всей исполняемой части услуги, только роль с inventory:cost; отсутствие означает неизвестную стоимость.

Основные ошибки: VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, ORDER_STATE, CUSTOMER_SCOPE, WAREHOUSE_SCOPE, ACCOUNT_SCOPE, DUPLICATE_LINE, QUANTITY_EXCEEDS, RETURN_EXCEEDS, PAYMENT_EXCEEDS, REFUND_EXCEEDS, INSUFFICIENT_STOCK, INSUFFICIENT_MONEY, ACCOUNT_EXISTS, ACCOUNT_LIMIT, SAME_ACCOUNT, AMOUNT_LIMIT, CALENDAR_LIMIT. Запросы с неподдерживаемыми полями/задними датами отклоняются. Финансовый импорт, сторнирование прочих расходов и полноценный OpenAPI пока не реализованы.

## Закупки и CRM: срез передачи

Источник точных полей и схем: `src/domain/purchasing.ts`, `src/domain/crm.ts`; маршрутизация — `src/server/http.ts`. Базовый путь `/api/v1/organizations/:id`. Новые бизнес-команды используют key UUID, версии редактируемых документов, авторизацию и транзакционный audit. Денежные итоги — строковые тиыны, количества — decimal строки.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET/POST | suppliers | Поставщики |
| POST | supplier-offers | Снимок предложения |
| POST | purchasing/compare, purchasing/need, purchasing/budget | Расчёты без изменения учёта |
| GET/POST | purchases | Список / создание заказа |
| GET | purchases/:id | Заказ, строки, история |
| POST | purchases/:id/commands, purchases/:id/receipts | Состояния / фактическая приёмка |
| GET/POST | purchase-documents | Список / загрузка оригинала |
| GET | purchase-documents/:id, purchase-documents/:id/original | Документ / оригинал filename+base64 |
| POST | purchase-documents/:id/review-preview | Сверка без записи |
| POST | purchase-documents/:id/review-draft | Версия исправлений без обязательства |
| POST | purchase-documents/:id/review | Подтверждение и обязательство, без склада |
| GET/POST | crm/pipeline | Стадии / настройка owner/manager |
| GET/POST | crm/customers | Список / ручной клиент |
| POST | crm/customers/:id | Профиль, ответственный, согласия |
| GET | crm/customers/:id/history | История |
| GET/POST | crm/inquiries | Обращения |
| POST | crm/inquiries/:id | Смена стадии с основанием |
| GET/POST | crm/quotes | Предложения |
| GET/POST | crm/quotes/:id | Чтение / новая версия |
| POST | crm/quotes/:id/convert | Единственный связанный черновик заказа |
| GET | crm/quotes/:id/pdf?locale=ru\|kk | Binary PDF attachment |

Закупки читают owner/manager/purchasing/finance; изменяют owner/manager/purchasing; согласуют owner/manager. CRM использует customers permissions и область филиала; finance не получает CRM-доступ. После превращения предложение не редактируется. Оригиналы доступны только авторизованно, публичных ссылок нет.

Загрузка: JSON с base64, HTTP body до 7.1 МБ; сам файл до 5 МБ, PDF до 5 страниц, изображения до 16 мегапикселей; CSV/TSV до 256 КБ. OCR timeout 90 секунд, максимум два одновременных child process на web-процесс. Остальные JSON-команды ограничены 16 КБ.

Контракты прежних ответов расширены: order inquiry_id/quote_id nullable, customer source_file/source_row nullable для ручных записей, obligation purchase_order_id nullable, calendar kind дополнительно purchase. План закупки уменьшается на связанные подтверждённые обязательства.

## T020–T030: исполнение, знания, AI и интеграции

Маршруты организации собраны в таблице `src/server/routes/execution.ts` (путь после `organizations/:id/`); ответы проверяются Zod из `src/domain/{tasks,knowledge,decisions,automations,assistant}.ts`. Все команды принимают UUID `key` (повтор с тем же телом возвращает прежний результат, с другим — 409 IDEMPOTENCY_CONFLICT) и `version` для изменяемых объектов (409 VERSION_CONFLICT). Права проверяются заново на каждом вызове, в том числе при повторе ключа.

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | purchase-documents/:docId/review, review-draft, review-preview | строки с `decision` accept/substitute/reject/separate, `itemId` может быть null для неизвестной строки, `replacesItemId` для замены; preview возвращает total_minor и payable_minor |
| POST | purchase-documents/:docId/adjustments | key, version, reason, lines[{lineId, baseQuantity, total}]; только purchasing:approve |
| GET | purchase-documents/:docId | + decisions, adjustments, obligation, parent_document_id, received_value_minor строк |
| GET/POST | tasks | список (state, scope=mine/all, q) / создание |
| GET | tasks/:id | задача, чеклист, комментарии, вложения, история, permissions |
| POST | tasks/:id/commands | assign, start, block, unblock, check, complete(note, operation), verify, return, cancel |
| POST | tasks/:id/comments, tasks/:id/attachments | комментарий; файл PNG/JPEG/PDF ≤ 2 МБ base64 |
| GET | tasks/:id/attachments/:attachmentId | файл (base64) после проверки доступа |
| GET | tasks/assignees, tasks/templates, tasks/schedule, tasks/workload | исполнители в области, шаблоны, рабочее время, нагрузка |
| POST | tasks/templates, tasks/templates/:id/tasks, tasks/schedule | шаблон, задача из шаблона, рабочее время (организация целиком) |
| GET/POST | notifications, notifications/read | внутренние уведомления пользователя |
| GET/POST | knowledge, knowledge/uploads | список/создание текста, загрузка TXT/MD/PDF ≤ 3 МБ |
| GET | knowledge/search?q= | только опубликованные версии в области пользователя |
| GET | knowledge/:id[?number=], knowledge/:id/original?number= | документ и версия; оригинал файла |
| POST | knowledge/:id/versions, knowledge/:id/publication | новая версия; publish(number) или archive |
| GET | today | ситуации (до 5), задачи, решения, показатели, источники |
| GET/POST | insights, insights/refresh | список (state, rule) / пересчёт правил |
| GET/POST | insights/reorder-points | пороги запаса (inventory:write, version) |
| GET/POST | insights/:id, insights/:id/commands, insights/:id/proposal | ситуация; acknowledge/dismiss; черновик предложения |
| GET/POST | proposals, proposals/:id, proposals/:id/commands, proposals/:id/revisions | submit, approve/reject(paramVersion, note), execute, cancel; изменение параметров |
| GET/POST | proposals/policy, proposals/policy/limits, proposals/policy/delegations, …/:id/revoke | лимиты (owner), делегирование |
| GET/POST | automations, automations/:id, automations/:id/versions, automations/:id/tests, automations/:id/commands | правила, версии, тест, activate/pause/disable |
| POST | automations/draft | `{locale, text}` → `{status: ok/invalid/refused/error/not_configured/budget_exceeded, draft, warnings, issues}`; черновик не сохраняется (automations:write) |
| GET/POST | automations/templates, automations/executions, automations/executions/:id/retry | шаблоны, журнал, повтор ручного разбора |
| GET | assistant | статус провайдера/речи, настройки, потребление, инструменты |
| POST | assistant/settings | только owner |
| GET | assistant/conversations, assistant/conversations/:id | только свои разговоры |
| POST | assistant/messages | key, conversationId, locale, text → сообщение со status/sources/tool_calls/unverified_numbers |
| POST | assistant/transcriptions | key, locale, mime, audio ≤ 2 МБ; без провайдера 503 VOICE_NOT_CONFIGURED |
| GET/POST | integrations | обзор с паспортами / настройка токена (owner); токен вебхука возвращается один раз |
| POST | integrations/:id/check, sync, disconnect, links, links/:warehouseId/remove; GET integrations/:id/stores | проверка, синхронизация, отключение, связь складов |
| POST | integrations/conflicts/:id | kept_local / took_remote |
| GET | integrations/:id/parties?search= | юрлица и контрагенты МойСклад для явного выбора (owner) |
| POST | integrations/:id/supply | `{key, version, enabled, organizationId}` — включение/выключение записи приёмки; юрлицо и валюта KZT проверяются в API МойСклад (owner) |
| POST | integrations/:id/counterparties | `{key, supplierId, counterpartyId|null}` — сопоставление поставщика с контрагентом (owner); 409 COUNTERPARTY_MAPPED |
| POST | integrations/exports/:id/retry | `{key}` — повтор выгрузки в состоянии dead/failed (owner) |

Публичный входящий маршрут: `POST /api/integrations/moysklad/:connectionId/:token?requestId=…` — без сессии и Origin, тело ≤ 64 КБ, токен сравнивается по хешу, повтор requestId возвращает `{accepted:true, duplicate:true}`. Обработка выполняется worker.

Основные новые ошибки: 409 TASK_STATE, PROPOSAL_STATE, PARAMS_CHANGED, APPROVAL_REQUIRED, APPROVAL_REVOKED, RULE_NOT_TESTED, EXTERNAL_SOURCE_OF_TRUTH, WAREHOUSE_HAS_LEDGER; 403 SELF_APPROVAL, APPROVAL_LIMIT; 422 LINE_DECISION_REQUIRED, UNIT_MISMATCH, CHECKLIST_INCOMPLETE, EVIDENCE_REQUIRED, EVIDENCE_NOT_MET, NO_COMPARABLE_OFFER, QUANTITY_BELOW_RECEIVED, VALUE_BELOW_RECEIVED, OBLIGATION_PAID_EXCEEDS; 503 CREDENTIAL_STORAGE_NOT_CONFIGURED, VOICE_NOT_CONFIGURED. Тексты RU/KK — `src/lib/execution-i18n.ts`.

## T031–T040 (организация: `organizations/:id/…`)

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | integrations/bitrix24, …/:id/check, sync, disconnect; integrations/bitrix24/conflicts/:id | вебхук портала (owner), проверка, синхронизация контактов, конфликты |
| POST | integrations/onec, …/:id/check, sync, disconnect; integrations/onec/conflicts/:id | OData-база 1С (owner) |
| GET/POST | bank/statements, bank/statements/:id | выписки и строки; загрузка `{key, accountId, filename, content(base64)}` (finance:write) |
| POST | bank/accounts, bank/lines/:id | IBAN счёта; решение по строке `{key, version, kind: post/match/ignore, …}` |
| POST | integrations/telegram, …/:id/check, webhook, outbound, links, messages, disconnect; GET …/:id/messages | бот, вебхук (origin HTTPS), исходящие (owner), код привязки, отправка (customers:write) |
| POST/GET | integrations/kaspi, …/:id/check, sync, orders, disconnect | токен и склад (owner), чтение заказов |
| GET/POST | integrations/kaspi/:id/trade, products, writes | T040: обзор, связь кода товара `{key, productCode, itemId}`, разрешение смены статусов (owner) |
| GET | channel-orders | заказы Kaspi активного подключения для страницы продаж (orders:read) |
| POST | channel-orders/:id/import, accept | `{key, version}` — в продажи с резервом; подтверждение в Kaspi → `{state: sent/unknown/failed}` |
| POST | channel-orders/:id/issue, return | `{key, note}` — выдать остаток; вернуть выданное на склад |
| POST | channel-orders/:id/settlements | `{key, kind: payout/return, accountId, document, reportDate, gross, commission, net}` (finance:write) |
| GET/POST | video/sources, video/sources/:id/token, configs, stats, signals, runs | источники и паспорт, токен устройства (owner, один раз), версии линий/зон, почасовая статистика с покрытием |
| POST | video/runs/:id/annotations, video/evaluations, video/signals/:id/task; GET video/detectors | разметка, оценка, задача из сигнала, статусы детекторов |
| GET/POST/PATCH | marketing/campaigns, marketing/campaigns/:id | список, создание `{key, data}`, карточка с оценкой/версиями/журналом, новая версия `{key, version, data, note}` |
| POST | marketing/evaluate | оценка маржи/наличия без сохранения |
| POST | marketing/campaigns/:id/decisions | `{key, version, kind: submit/approve/reject/archive, note, override?}` |
| GET/POST | marketing/campaigns/:id/template, images, images/generate, images/:imageId | шаблон RU/KK, загрузка PNG/JPEG, генератор → 409 IMAGE_GENERATOR_NOT_CONFIGURED |
| POST | marketing/campaigns/:id/exports, publications, spend | PDF `{material: poster/price_tag/card, locale}` (base64), очередь Telegram (marketing:approve), фактические расходы |
| GET/POST | marketing/campaigns/:id/analysis, marketing/segments/preview, marketing/recommendations?itemId&days | анализ с контрольным периодом, подсчёт сегмента, совместные покупки |

Публичные маршруты: `POST /api/integrations/bitrix24/:connection/:token`, `POST /api/integrations/telegram/:connection/:token` (заголовок `X-Telegram-Bot-Api-Secret-Token`), API устройства видео `/api/video/{config,runs,heartbeat,events,end}` (`Authorization: Device <token>`, `X-Source-Id`).

Новые ошибки (тексты RU/KK — `src/lib/execution-i18n.ts`): 409 MARGIN_BELOW_THRESHOLD, MARGIN_UNKNOWN, CAMPAIGN_NOT_APPROVED, OFFER_CHANGED, CAMPAIGN_INVALID, PRODUCT_NOT_LINKED, TOTAL_MISMATCH, LINE_TOTAL_MISMATCH, CHANNEL_WRITES_OFF, ACCEPT_ALREADY_SENT, SETTLEMENT_DUPLICATE, RETURN_GOODS_FIRST, MESSAGING_DISABLED, NO_CONSENT; 403 OVERRIDE_FORBIDDEN, SELF_APPROVAL; 422 SETTLEMENT_ARITHMETIC, OVERRIDE_REASON, IMAGE_TYPE.

## T041–T045: отраслевые операции (миграция 21)

Все пути ниже относительно `/api/v1/organizations/:id`; owner/manager, область организации и филиала проверяется сервером. GET требует industry:read, POST industry:write. Вход — строгий discriminated union `src/domain/industry.ts`, выход проверяется Zod в execution routes.

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | industry?branchId&kind | Последние 200 документов и партий доступного филиала, профиль/timezone |
| GET | industry/:id | Документ, последние 100 версий истории и до 200 партий филиала |
| POST | industry/commands | Одна транзакционная бизнес-операция; ответ {id,reused} |

Создание: `key` UUID + `branchId`. Изменение: `key` + `id` + `version` + основание `note`. Рецептура при редактировании содержит оба набора. Повтор ключа проверяет актуальные права; изменение тела с тем же ключом отклоняется. lot_receipt возвращает ID складского движения, прочие команды — ID документа.

- Рецептуры/производство: recipe (mode, outputItemId, outputQuantity, ingredients с lossPercent, stages); lot_receipt (warehouseId,itemId,quantity,unit,unitCost,lotCode,expiresOn); production_plan (recipeId,warehouseId,quantity,salesOrderId?,equipmentId?,startsAt?,endsAt?); production_issue (materials); production_stage (stage,defects,reworked); production_finish (goodQuantity,scrapQuantity,lotCode,expiresOn); waste (warehouseId,itemId,lotId,quantity).
- Ресурс: resource (resourceKind,capacity,bufferMinutes,days 1–7,opens,closes). capacity — число параллельных бронирований; specialist/teacher/workplace = 1. Слот содержит startsAt/endsAt ISO с offset и массив resources. UI переводит местное время timezone организации в UTC и отклоняет неоднозначность/пропуск DST.
- Услуги: appointment (slot,customerId,inquiryId?,serviceItemId,price,warehouseId,materials); reschedule (slot); appointment_end (completed/cancelled/no_show); reminder (connectionId,text). Последнее создаёт очередь, не подтверждает доставку.
- Обучение: course (serviceItemId,warehouseId,lessonPrice,lessons); group (courseId,capacity); enroll (groupId,customerId,guardianId,inquiryId?,endsOn); enrollment_change (action freeze/resume/extend/withdraw,until,additionalLessons); lesson (groupId,slot); lesson_complete (attendance[{enrollmentId,present}]). Дополнительные занятия допустимы только при продлении.
- Проекты: project (quoteId,warehouseId,budget,estimatedHours?,team,stages); project_task (title,memberId,stage); time (memberId,stage,hours,hourlyRate,workedOn); scope_change (budget,extraPrice,description); scope_approve; project_stage (stage); project_deliver. Согласование изменения другим owner/manager, привязано к версии.

Складские receipt/count и строки фактической приёмки закупки дополнены необязательным `lot:{code,expiresOn}`. Для товара с партиями новая положительная операция требует партии. issue дополнен lotId (для явного выбора). Стоимость по-прежнему средневзвешенная SKU/склад; FEFO используется только для физического выбора партий. Возврат восстанавливает исходное распределение, перемещение сохраняет родительскую партию/срок. Обычная выдача просроченного товара запрещена. Списание просрочки — только industry waste с основанием. Независимый складской возврат связанного производственного расхода запрещён.

Ключевые ошибки: VERSION_CONFLICT, RESOURCE_CONFLICT, OUTSIDE_WORKING_HOURS, GROUP_FULL, ATTENDANCE_INCOMPLETE, COURSE_LIMIT, BUDGET_EXCEEDED, SECOND_PERSON_REQUIRED, PROJECT_TASKS_OPEN, STAGES_REQUIRED, OUTPUT_MISMATCH, LOT_AVAILABLE_EXCEEDED, LOT_REQUIRED, LOT_OPENING_REQUIRED, PROFILE_NOT_SUPPORTED. Тексты отраслевой формы RU/KK — industry-i18n.ts.

## T046–T050: строительство, клиника, результаты

Миграции 22–23. Пути относительно /api/v1/organizations/:id. Все команды требуют текущую авторизацию, UUID key, Zod input/output; изменяемые industry документы требуют id/version/note. Повтор key не отменяет проверку прав. Смета и клиника используют тот же industry/commands, history и scope, что T041–T045.

| Команда | Данные / действие |
| --- | --- |
| construction | branchId, title, customerId, warehouseId, billingItemId(service), budget, lines[{itemId,quantity,unit,price}], stages, note → pending |
| construction_revise | id/version, budget, lines, stages → новая версия сметы, pending; фиксированные работы/закупки сохраняются |
| construction_approve | Другой owner/manager утверждает текущую версию |
| construction_purchase | supplierId, date, dueDate, lines[{offerId,quantity}] → реальный draft закупки в рамках сметы/бюджета |
| construction_materials | materials[{itemId,quantity,unit}] → фактическая выдача только после приёмки |
| construction_work / construction_confirm | stage, contractorId, amount, evidence / workId; другой проверяющий создаёт обязательство, но не платёж |
| construction_accept | Все этапы/работы проверены, закупки приняты или отменены, материалы выданы → исполненный заказ |
| clinic | branchId, patientName, contact, serviceItemId, warehouseId, price, note → приватная requested |
| clinic_book | startsAt/endsAt, resources (specialist+room) → scheduled; повтор — перенос с сохранением старого слота при ошибке |
| clinic_visit | outcome visited/no_show/cancelled; посещение не ранее начала |
| clinic_invoice | Только visited → один обезличенный исполненный заказ; финансовое движение отдельно |
| GET outcomes?branchId&from&to | outcomes:read, owner/manager; когорта до 366 дней, до 5000 записей с явным отказом при превышении; facts/proposals/actions/measurements и раздельные итоги |
| POST outcomes | outcomes:write; key, branchId, sourceType order/purchase, sourceId, forecast(decimal|null), alternativeOfferIds[], limitations; immutable baseline до исполнения |

Для purchase baseline требуется по альтернативе на каждую позицию, один поставщик, равный фактический объём упаковок, одинаковые leadDays/paymentTerms и известные условия цены. Факт — полная приёмка плюс обязательства поставщику (с учётом корректировок). Изменённый объём или реально принятый заменяющий SKU → incomparable. Для order факт — текущая выручка исполненного заказа, difference = факт − прогноз; для purchase difference = baseline − фактическая стоимость. Это разные показатели, они не суммируются. Прогнозы не добавляются к выручке.

Новые ошибки: ESTIMATE_COMMITTED, RECEIPT_REQUIRED, OUTCOME_ALREADY_TRACKED, BASELINE_TOO_LATE, RESULT_RANGE_TOO_LARGE; сохраняются VERSION_CONFLICT, SECOND_PERSON_REQUIRED, BUDGET_EXCEEDED, RESOURCE_CONFLICT, FORBIDDEN. Контакт пациента доступен только industry API своей области; общего AI tool для clinic/industry/outcomes не зарегистрировано.

## T051–T058: изменения экранов, обезличивание, экспорт, эксплуатация

Миграция 24. Пути относительно /api/v1/organizations/:id, кроме `/api/health`. Повтор key не отменяет проверку актуальных прав.

| Метод | Путь | Данные / действие |
| --- | --- | --- |
| GET | changes | Любой участник. `{cursor}` (32 символа): хеш числа и времени последних записей аудита в области пользователя (организация или его филиал). Клиент (`LiveSync`) опрашивает раз в секунду при видимой вкладке и перечитывает экран при смене курсора; данных не содержит |
| POST | privacy/customers/:customerId/erase | Только owner (`organization:write`). `{key, version, reason: subject_request/retention_expired/consent_withdrawn}` → `{id, reused?, counts}`. Необратимо обезличивает клиента, обращения, заметки CRM, строки импорта, сообщения; удаляет коды привязки; внешние сопоставления контакта/чата → deleted (повторная синхронизация не возвращает данные). Заказы, деньги и склад сохраняются с обезличенным клиентом. Ошибки: SUBJECT_ERASED, TECHNICAL_CUSTOMER (расчётные клиенты клиники/канала), VERSION_CONFLICT, NOT_FOUND |
| POST | privacy/clinic/:documentId/erase | Только owner. Тот же ввод; стирает имя/контакт пациента в документе клиники, снимках истории и заметки персонала; время, услуга, счёт и деньги остаются |
| GET | privacy/requests | Только owner. Журнал: кто, когда, основание, количества — без стёртых значений |
| GET | export | Только owner. JSON-выгрузка организации (до 50 000 строк всего, при превышении — EXPORT_TOO_LARGE 413), без столбцов с секретами/хешами и без бинарных оригиналов; действие пишется в аудит. Полная выгрузка с оригиналами — `npm run org:export -- --org <id> --binaries` на сервере |
| GET | /api/health | Без авторизации и без данных организаций: `{status ok/degraded/error, database, schema ok/mismatch, migration, pendingMigrations, worker ok/stale/unknown, workerHeartbeatAgeSeconds}`; 503 при недоступной базе или несовпадении схемы |

Изменённые записи после обезличивания: команды над стёртым клиентом/документом клиники отвечают SUBJECT_ERASED (409); чтение истории остаётся.

Командные инструменты (не HTTP): `test:load`, `measure:files`, `db:backup`, `db:restore`, `test:restore`, `db:migrate -- --plan`, `ops:retention [-- --apply]`, `org:export`, `check:secrets`, `live:report`, `eval:assistant [-- --confirm-budget N]`, `ocr:check`, `voice:check`, `video:probe`, `pilot:metrics`. Описание — docs/RUNBOOK.md и docs/LIVE_ACCEPTANCE.md.


## Уточнения после ревью T051–T058 (16.10.2026)

- `GET …/export`: таблицы `assistant_conversations` и `assistant_messages` исключены независимо от роли владельца; приватный доступ автора остаётся через assistant API. Полная операторская резервная копия — отдельная процедура.
- Старый `PATCH …/customers/:id` возвращает `409 SUBJECT_ERASED` для обезличенного клиента. В ответе обезличивания дополнительные counts: `importSources`, `syncConflicts`.
- История импорта после обезличивания сохраняет четыре строковых поля `values` (пустые), `errors: ["SUBJECT_ERASED"]`; готовые строки становятся invalid, выполненные сохраняют статус и ссылку. Весь исходный CSV затронутой партии удаляется, остальные нормализованные строки доступны. Повтор того же файла дедуплицируется; новые CSV с удалённым external_id блокируют эту строку в том же филиале.
- Assistant status: `usage.month_tokens` — подтверждённый расход месяца, `usage.committed_tokens` — расход плюс активные/неподтверждённые резервы. Chat и automation_draft используют общий бюджет. `ASSISTANT_BUDGET_EXCEEDED` возникает до платного вызова, если остатка недостаточно для резерва; `ASSISTANT_INPUT_TOO_LARGE` — слишком большой или некорректный результат счётчика входа; `ASSISTANT_BUDGET_MISMATCH` — фактический расход превысил envelope, следующие запросы заблокированы до сверки.


## T056: бесплатный AI — 16.10.2026

Контракт assistant API и бизнес-инструментов сохранён. Серверное `ASSISTANT_PROVIDER=free` выбирает Google Gemma 4 26B → OpenRouter Nemotron Super VL :free; статус показывает основную настроенную модель, журнал использования — фактически ответившего провайдера/модель. `gemini`/`openrouter` — один адаптер, `disabled` — отключение. Ключи в серверном окружении. Условия синтетического режима, лимитов и переключения — AI_PROVIDERS.md. Бюджет списывается/резервируется отдельно для каждой попытки; отказ, ошибки валидации и прав не обходятся fallback.

## Голос, камера и демо — 16.10.2026

`POST organizations/:id/assistant/transcriptions` — контракт прежний (`key, locale ru|kk, mime, audio` base64). С `SPEECH_PROVIDER=local` принимается только `audio/wav` (браузер сам переводит запись в 16 кГц моно WAV); ответ `{text, locale, confidence, uncertain[]}`, где `uncertain` — слова, которые пользователь обязан проверить до отправки (неуверенные слова; суммы, количества и отрицания при уверенности < 0,9). Расшифровка ничего не отправляет и не выполняет. Новые ошибки: `VOICE_FORMAT` 415 (не WAV или повреждённый файл), `VOICE_EMPTY` 422, `VOICE_BUSY` 429 (больше трёх записей в очереди), `VOICE_TIMEOUT` 504 (предел 150 с), `VOICE_MODEL_MISSING` 503 (модель не скачана). `GET assistant` при включённом голосе заранее запускает загрузку локальной модели.

`GET organizations/:id/proposals/:id` дополнительно возвращает `offers[]` — для строк предложения закупки поставщика, SKU, название RU/KK, упаковку и цену (только чтение; параметры предложения не менялись).

Видео: машинный API устройства прежний. `summary` прогона (`POST /api/video/end`) теперь содержит `people: {mode: neural|motion, detector, tracker: bytetrack|nearest}` — чем посчитаны люди; список прогонов источника показывает это поле.

Разбор документа OCR: строки свободного текста теперь сохраняют разделители тысяч («1 300,00») и принимают разбиение «количество × цена = сумма»; кандидат без такого совпадения сохраняется, как раньше, с пониженной уверенностью. Форма проверки накладной заполняется кандидатами как редактируемыми подсказками; сервер проверяет итог как прежде.

## T057 камеры и T056 помощник — 16.10.2026 (вечер)

Видео (миграция 26: `video_runs.pipeline jsonb`):

| Метод | Путь (`/api/v1/organizations/:org/…`) | Права | Что делает |
| --- | --- | --- | --- |
| POST | `video/sources/:id/token` `{replace?: boolean}` | owner (`video:manage`) | Если токен уже есть, без `replace: true` — 409 `VIDEO_TOKEN_REPLACE_CONFIRM`. С подтверждением старый токен сразу перестаёт приниматься |
| GET | `video/sources/:id/live` | `video:read`, филиал источника | `online` (поток моложе 30 с), `now` (люди на последнем обработанном кадре; только если сигнал моложе 15 с, иначе `null` = «Нет свежих данных»), `metrics.inputFps` (фактически поступает) и `processingFps` (успевала бы модель), `diagnosis`, `today {in, out}` по событиям линий за день в часовом поясе организации, `run.pipeline` |
| POST | `video/sources/:id/view` → `{frame \| null}` | `video:read`, филиал источника | Просмотр: последний обработанный кадр (JPEG base64, размер входа модели) с рамками; запрос держит передачу кадров устройством 15 с. Кадры только в памяти сервера, не старше 10 с |
| POST | `video/sources/:id/unview` | то же | Остановить просмотр, кадр удаляется |
| POST | `video/live` `{key, kind: camera\|file, fps 1–10, lines, zones}` | `video:read` | «Проверка на видео»: сессия анализа в памяти (одна на пользователя, до 4 на сервер, конец через 60 с без кадров), аудит `video.live_analysis_started`. Ответ: модель и размер входа |
| POST | `video/live/:id/frames` `{seq, rgb: base64}` | только автор сессии | Кадр RGB размера входа модели (до 1,8 МБ тела) → рамки, `visible`, зоны, входы/выходы, `totals {unique, peak, averageSeconds, averageMs}`, `diagnosis`. Другой пользователь — 404 `VIDEO_LIVE_ENDED`; второй кадр, пока считается первый, — 429 |
| POST | `video/live/:id/stop` | автор | Идемпотентно |

Устройство (`/api/video/*`, `Authorization: Device <token>`): `runs` принимает `pipeline {mode, detector, tracker, fps}`; `heartbeat` — дополнительно `inputFps`, `now`, `diagnosis` и отвечает `{ok, preview}` (смотрит ли кто-то источник); новый `POST /api/video/preview` `{runId, at, image (JPEG base64 ≤ 700 000), width, height, visible, people[{id, box, counted, seen}], zones, crossings}` — принимается только при открытом просмотре и для идущего прогона, хранится только последний кадр в памяти. Отказ сервера (4xx) обработчик не повторяет: он останавливает ffmpeg, освобождает камеру и печатает причину.

Помощник: ответ `assistant/transcriptions` не изменился, но `uncertain` больше не блокирует отправку: экран сам отправляет распознанный вопрос один раз (пустая запись, отмена и ошибка распознавания — ничего не отправляют). `POST assistant/messages` принимает необязательное `voice: {uncertain: string[] ≤ 20}` — вопрос пришёл из распознавания речи; модель получает пометку и может переспросить. Ответы инструментов для модели — компактные сводки (ограниченные выборки с `total`/`shown`, без служебных полей); полный список источников по-прежнему возвращается в `sources` сообщения.
