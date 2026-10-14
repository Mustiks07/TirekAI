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
