# API v1

Все ответы: `{ data, requestId }` или `{ error: { code, requestId } }`. Кэширование отключено. Мутации требуют JSON и точный Origin из APP_ORIGIN, вход ограничен 16 KiB. Ошибки схемы возвращают `400 INVALID_INPUT`. Неизвестный маршрут возвращает 404.

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

Схемы команд: `src/domain/contracts.ts`; используются сервером. OpenAPI и проверка схем ответов относятся к незавершённой T002. В истории максимум 30 событий, в invites максимум 50 записей. Пагинация полного журнала ещё не реализована и не заявлена. Команда и филиалы пока без пагинации; нагрузочный сценарий не принят.
