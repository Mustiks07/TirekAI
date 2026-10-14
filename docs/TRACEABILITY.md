# Матрица требований → задач → тестов → результата

Восстановленная первичная трассировка. Отсутствующий тест явно помечен, проверка будущего модуля не заменяется проверкой оболочки.

| Требование | Задачи | Тест / доказательство | Результат |
| --- | --- | --- | --- |
| §4 Организации, роли, филиалы | T003,T004 | tests/foundation.test.ts; tests/e2e/foundation.spec.ts | Локальный срез, остальные поверхности не реализованы |
| §6 KK/RU и мобильный интерфейс | T005 | Browser QA, e2e/pwa.spec.ts, docs/evidence | PWA manifest/offline/cache пройдены; нативные устройства ещё не приняты |
| §17–18 Архитектура и API | T001,T002,T008 | foundation.test.ts, imports.test.ts, restart.test.ts | Decimal, новые контракты и очередь проверены локально; старые API/PG-конкуренция открыты |
| REQ CRM 01 | T013 | imports.test.ts, e2e/imports.spec.ts | Частично: контакты, источник, версии и branch scope; виды/согласия/ответственные/история впереди |
| REQ CRM 02 | T009,T013,T034 | Не создан | planned |
| REQ CRM 03 | T013 | Не создан | planned |
| REQ CRM 04 | T013,T027 | Не создан | planned |
| REQ CRM 05 | T014 | Не создан | planned |
| REQ CRM 06 | T023 | Не создан | planned |
| REQ INV 01 | T010 | inventory.test.ts, e2e/inventory.spec.ts | SKU, RU/KK, категория/штрихкод/вариант, единицы, цены, товар/услуга verified_test; импорт каталога впереди |
| REQ INV 02 | T010 | inventory.test.ts | Склады/филиалы verified_test; партии, сроки, серийные номера и ячейки не реализованы |
| REQ INV 03 | T011,T012 | inventory.test.ts, e2e/inventory.spec.ts | Приёмка, выдача, резерв, путь/приёмка, инвентаризация, возврат по выдаче; возврат поставщику и отдельное списание впереди |
| REQ INV 04 | T012 | inventory.test.ts | physical/reserved/available и in_transit разделены; локально verified_test |
| REQ INV 05 | T012 | inventory.test.ts | Последний резерв один успешный в PGlite; PG-конкуренция и owner exception отрицательного остатка впереди |
| REQ INV 06 | T011,T016 | inventory.test.ts | Средневзвешенная, точные суммы, исходная стоимость возврата verified_test; партийная оценка/задний пересчёт/финансовые отчёты впереди |
| REQ INV 07 | T042 | Не создан | planned |
| REQ PUR 01 | T017 | Не создан | planned |
| REQ PUR 02 | T017 | Не создан | planned |
| REQ PUR 03 | T018 | Не создан | planned |
| REQ PUR 04 | T018 | Не создан | planned |
| REQ PUR 05 | T018,T024 | Не создан | planned |
| REQ PUR 06 | T019 | Не создан | planned |
| REQ PUR 07 | T020 | Не создан | planned |
| REQ PUR 08 | T019,T020 | Не создан | planned |
| REQ FIN 01 | T015 | Не создан | planned |
| REQ FIN 02 | T015 | Не создан | planned |
| REQ FIN 03 | T016 | Не создан | planned |
| REQ FIN 04 | T016 | Не создан | planned |
| REQ FIN 05 | T048 | Не создан | planned |
| REQ OPS 01 | T021 | Не создан | planned |
| REQ OPS 02 | T021 | Не создан | planned |
| REQ OPS 03 | T021,T025 | Не создан | planned |
| REQ OPS 04 | T022 | Не создан | planned |
| REQ OPS 05 | T021,T048 | Не создан | planned |
| REQ MKT 01 | T039 | Не создан | planned |
| REQ MKT 02 | T039 | Не создан | planned |
| REQ MKT 03 | T039 | Не создан | planned |
| REQ MKT 04 | T039 | Не создан | planned |
| REQ MKT 05 | T039 | Не создан | planned |
| REQ CAM 01 | T035 | Не создан | planned |
| REQ CAM 02 | T036 | Не создан | planned |
| REQ CAM 03 | T037 | Не создан | planned |
| REQ CAM 04 | T038 | Не создан | planned |
| REQ CAM 05 | T037,T038 | Не создан | planned |
| REQ CAM 06 | T035 | Не создан | planned |
| REQ CAM 07 | T035,T036 | Не создан | planned |
| REQ CAM 08 | T035 | Не создан | planned |
| REQ AI 01 | T026,T027 | Не создан | planned |
| REQ AI 02 | T027 | Не создан | planned |
| REQ AI 03 | T027 | Не создан | planned |
| REQ AI 04 | T024,T027 | Не создан | planned |
| REQ AI 05 | T016,T027 | Не создан | planned |
| REQ AI 06 | T028 | Не создан | planned |
| REQ AI 07 | T028 | Не создан | planned |
| REQ AI 08 | T026 | Не создан | planned |
| REQ AI 09 | T027 | Не создан | planned |
| REQ AUT 01 | T025 | Не создан | planned |
| REQ AUT 02 | T025 | Не создан | planned |
| REQ AUT 03 | T025 | Не создан | planned |
| REQ AUT 04 | T025 | Не создан | planned |
| REQ AUT 05 | T025 | Не создан | planned |
| REQ AUT 06 | T025 | Не создан | planned |
| AC 01 | T003,T004 | tests/foundation.test.ts; tests/e2e/foundation.spec.ts | Локальный срез; полная приёмка впереди |
| AC 02 | T009 | imports.test.ts, restart.test.ts, e2e/imports.spec.ts | verified_test: клиенты CSV/TSV, preview/partial/replay/source/date; PostgreSQL-конкуренция не проверена |
| AC 03 | T010–T016 | Не создан | planned |
| AC 04 | T018,T023,T024 | Не создан | planned |
| AC 05 | T017,T020 | Не создан | planned |
| AC 06 | T016 | Не создан | planned |
| AC 07 | T021–T025 | Не создан | planned |
| AC 08 | T035–T038 | Не создан | planned |
| AC 09 | T026,T027 | Не создан | planned |
| AC 10 | T028,T056 | Не создан | planned |
| AC 11 | T025 | Не создан | planned |
| AC 12 | T029–T034 | Не создан | planned |
| AC 13 | T040–T047 | Не создан | planned |
| AC 14 | T039 | Не создан | planned |
| AC 15 | T004,T049 | tests/foundation.test.ts; tests/e2e/foundation.spec.ts | Локальный срез; полная приёмка впереди |
| AC 16 | T050 | Не создан | planned |
| AC 17 | T049,T053 | Не создан | planned |
| AC 18 | T001,T054 | npm checks; CI-конфигурация | Локальный срез; полная приёмка впереди |
