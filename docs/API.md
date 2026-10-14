# API v1

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
