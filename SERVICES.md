# Сервисы для Shopify Bottle Deposit App

Актуальность проверки тарифов: **10 сентября 2026 года**. Лимиты бесплатных тарифов меняются, поэтому перед production-запуском их нужно проверить повторно.

## Рекомендуемый набор

| Задача | Сервис | Стоимость для разработки | Решение |
|---|---|---:|---|
| Shopify-приложение и dev store | Shopify Partners / Dev Dashboard | Бесплатно | Использовать |
| Backend embedded app | Render Web Service | Бесплатно для разработки | Использовать для dev/demo; production перевести на always-on instance |
| PostgreSQL | Neon Postgres | Бесплатный тариф | Использовать |
| Серверная логика корзины | Shopify Functions / Cart Transform | Входит в Shopify platform | Использовать |
| Интеграция с темой | Shopify Theme App Extension | Входит в Shopify platform | Использовать |
| Репозиторий | GitHub | Бесплатно | Использовать |
| CI | GitHub Actions | Бесплатный лимит | Использовать |
| Ошибки | Sentry | Бесплатный тариф | Опционально, рекомендуется |
| Uptime-проверки | Better Stack или UptimeRobot | Бесплатный тариф | Опционально |

## 1. Shopify

### Что используем

- Shopify Dev Dashboard;
- Shopify development store;
- Shopify CLI;
- Admin GraphQL API;
- App Bridge;
- Polaris App Home;
- Shopify Functions;
- Cart Transform API;
- Theme App Extension;
- app-owned metafields;
- Shopify webhooks.

### Стоимость

Разработка приложения и development store доступны без отдельной платы через Shopify developer/partner account. Реальный магазин работает на своём Shopify-тарифе владельца магазина.

### Зачем

Shopify должен оставаться источником истины для:

- товаров, вариантов, тегов и коллекций;
- корзины и checkout;
- скрытого варианта депозита;
- runtime-конфигурации Cart Transform;
- storefront-конфигурации, необходимой теме.

Критическая логика депозита выполняется Shopify Function, а не Render-сервером при каждом изменении корзины. Поэтому временная недоступность Render/Neon не должна убрать депозит из уже настроенной корзины.

### Документация

- Cart Transform: https://shopify.dev/docs/api/functions/latest/cart-transform
- Function metafields: https://shopify.dev/docs/apps/build/functions/input-queries/metafields-for-input-queries
- Function input variables: https://shopify.dev/docs/apps/build/functions/input-queries/use-variables-input-queries
- Theme App Extensions: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
- Resource Picker: https://shopify.dev/docs/api/app-home/apis/user-interface-and-interactions/resource-picker

## 2. Render

### Что используем

Один Render Web Service для:

- embedded admin app;
- OAuth callback;
- Admin GraphQL requests;
- страниц настроек;
- webhook endpoints;
- синхронизации конфигурации и продукта депозита.

### Бесплатный тариф

На момент проверки Render Free Web Service предоставляет:

- `$0/month` instance;
- 512 MB RAM;
- 0.1 CPU;
- до 750 free instance hours на workspace в месяц;
- spin down после 15 минут без входящего трафика;
- cold start примерно до минуты;
- ephemeral filesystem;
- отсутствие SSH и persistent disk.

Документация: https://render.com/docs/free

### Важное ограничение

Render прямо указывает, что Free instances предназначены для тестирования и hobby-проектов, а не production.

Shopify webhook delivery использует примерно:

- 1 секунду на установление соединения;
- 5 секунд на весь запрос.

Спящий Render Free service может не успеть проснуться. Это создаёт риск повторных webhook deliveries и удаления webhook subscription после серии неудач.

Документация Shopify: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries

### Решение

- **Разработка и demo:** Render Free подходит.
- **Production:** оставить Render, но перейти минимум на always-on paid web service.
- Не использовать локальную SQLite или файловое хранилище на Render.
- Webhooks должны быстро проходить HMAC-проверку, сохранять idempotency key и возвращать `200 OK`.

Не следует искусственно пинговать бесплатный сервис только ради обхода политики spin down. Для production нужна платная always-on инфраструктура.

## 3. Neon Postgres

### Что используем

Neon хранит:

- Shopify OAuth sessions;
- настройки магазинов;
- сумму и валюту депозита;
- GraphQL IDs продукта, варианта и Cart Transform;
- include/exclude rules;
- состояние установки;
- журнал синхронизаций и idempotency webhooks.

### Бесплатный тариф

На момент проверки Neon Free включает ориентировочно:

- `$0/month`;
- 100 CU-hours на проект;
- autoscaling до 2 CU;
- scale to zero после 5 минут;
- 0.5 GB storage на проект;
- 5 GB public network transfer;
- до 10 branches на проект;
- короткое окно истории/восстановления согласно текущему тарифу.

Официальная страница: https://neon.com/docs/introduction/plans

### Почему Neon лучше бесплатного Render Postgres

Render Free Postgres:

- ограничен 1 GB;
- истекает через 30 дней;
- не имеет backups;
- после grace period может быть удалён.

Neon Free лучше подходит для постоянной dev-базы и небольшого приложения, потому что не имеет указанного 30-дневного срока удаления базы и поддерживает scale to zero/branches.

### Подключение

- приложение использует pooled `DATABASE_URL`;
- Prisma migrations используют direct `DATABASE_URL_UNPOOLED`;
- секреты хранятся только в Render environment variables и локальном `.env`, который находится в `.gitignore`;
- для разработки желательно создать отдельную Neon branch.

Документация pooling: https://neon.com/docs/connect/connection-pooling

## 4. GitHub

### Что используем

- Git repository;
- pull requests;
- branch protection при необходимости;
- GitHub Actions для lint, typecheck, unit tests и Shopify extension build.

### Стоимость

Бесплатного тарифа достаточно для небольшого приватного репозитория и умеренного количества CI-запусков. Точный лимит Actions зависит от типа аккаунта и репозитория.

### Рекомендуемый CI

На каждый pull request:

1. install с lockfile;
2. lint;
3. typecheck;
4. unit tests;
5. Prisma schema validation;
6. Shopify app/extension build;
7. проверка отсутствия случайно добавленных `.env` и секретов.

## 5. Sentry — опционально

### Что используем

- ошибки embedded app;
- необработанные исключения webhook handlers;
- ошибки Admin API synchronization;
- release tracking.

### Стоимость

Для первого магазина обычно достаточно бесплатного developer-тарифа, но текущие лимиты событий нужно проверить перед подключением.

Сайт: https://sentry.io/

### Правила безопасности

Не отправлять в Sentry:

- Shopify access tokens;
- session cookies;
- полные webhook payloads;
- персональные данные покупателей;
- `DATABASE_URL` и другие secrets.

## 6. Uptime monitoring — опционально

Можно использовать Better Stack или UptimeRobot на бесплатном тарифе для проверки health endpoint production-сервиса.

Проверять:

- `/health` отвечает без обращения к Shopify;
- `/ready` проверяет доступность Postgres с коротким timeout;
- срок TLS-сертификата;
- доступность production admin app.

Эти проверки не решают проблему Render Free cold start. Для production webhook reliability нужен always-on hosting.

- Better Stack: https://betterstack.com/
- UptimeRobot: https://uptimerobot.com/

## 7. Что не требуется на MVP

### Redis

Не нужен, пока:

- один магазин или небольшая нагрузка;
- idempotency и короткие jobs можно хранить в Postgres;
- нет большого фонового queue workload.

Если появится очередь, сначала оценить Postgres-backed queue, чтобы не добавлять ещё один сервис.

### Object storage

Не нужен: приложение не хранит пользовательские файлы. Изображение продукта депозита можно хранить в Shopify Files или вообще не использовать.

### Отдельный backend для Shopify Function

Не нужен. Cart Transform Function выполняется внутри Shopify и получает конфигурацию из app-owned metafield.

### Отдельный frontend hosting

Не нужен. Embedded admin frontend и backend можно развернуть одним Render Web Service.

### Платный email provider

Не нужен на MVP. Системные ошибки контролируются через Sentry/monitoring, а merchant UI использует Shopify admin notifications.

## 8. Переменные окружения

Предварительный список без значений:

```text
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SHOPIFY_APP_URL
SCOPES
DATABASE_URL
DATABASE_URL_UNPOOLED
SENTRY_DSN                 # optional
NODE_ENV
```

Значения секретов нельзя коммитить. В репозитории допускается только `.env.example` с пустыми значениями.

## 9. Ожидаемые расходы

### Разработка

Можно начать с **€0/$0 в месяц**:

- Shopify development store — бесплатно;
- Render Free Web Service — бесплатно;
- Neon Free — бесплатно;
- GitHub — бесплатно;
- Shopify Functions и Theme App Extension — часть Shopify platform.

### Production

Полностью бесплатная production-схема не рекомендуется из-за Render cold starts и требований Shopify к webhook response time.

Минимальный ожидаемый внешний расход:

- always-on Render web service — по актуальному тарифу Render;
- Neon можно оставить на Free, пока хватает лимитов;
- Shopify plan уже оплачивается владельцем магазина;
- домен опционален, если используется домен Render.

## 10. Итоговое решение

Для проекта используем:

```text
Shopify React Router app
+ Shopify Admin GraphQL API
+ Polaris/App Bridge
+ Shopify Cart Transform Function
+ Shopify Theme App Extension
+ Render Web Service
+ Neon Postgres
+ GitHub/GitHub Actions
+ Sentry (optional)
```

**Render + Neon можно и целесообразно продолжить использовать.** Render Free подходит только для разработки и демонстрации. Для production приложение следует оставить на Render, но перевести web service в always-on режим; Neon Free можно использовать дольше, если база и трафик остаются в лимитах.
