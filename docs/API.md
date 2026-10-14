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
