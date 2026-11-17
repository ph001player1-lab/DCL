-- Анонимные пользователи: никаких имён, почты, телефонов.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,          -- случайный ID устройства
  key_hash       TEXT NOT NULL,             -- sha256 секретного ключа устройства
  created_at     INTEGER NOT NULL,          -- ms epoch
  tz             TEXT NOT NULL DEFAULT 'Europe/Moscow',
  wake_start     INTEGER NOT NULL DEFAULT 480,   -- минуты от полуночи (08:00)
  wake_end       INTEGER NOT NULL DEFAULT 1380,  -- 23:00
  pings_per_day  INTEGER NOT NULL DEFAULT 6,
  consent        INTEGER NOT NULL DEFAULT 0,     -- 1 = согласие передавать ответы анонимно
  paused_until   INTEGER NOT NULL DEFAULT 0,     -- ms epoch, «не беспокоить»
  push_endpoint  TEXT,
  push_p256dh    TEXT,
  push_auth      TEXT,
  plan_date      TEXT,                      -- локальная дата, на которую составлено расписание
  plan_until     INTEGER NOT NULL DEFAULT 0, -- ms epoch следующей локальной полуночи
  last_seen      INTEGER
);
CREATE INDEX users_plan ON users(plan_until);

-- Сигналы (случайные моменты замера)
CREATE TABLE pings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date    TEXT NOT NULL,
  scheduled_at  INTEGER NOT NULL,           -- ms epoch
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|sent|answered|skipped|expired|cancelled|failed
  sent_at       INTEGER,
  closed_at     INTEGER
);
CREATE INDEX pings_due ON pings(status, scheduled_at);
CREATE INDEX pings_user ON pings(user_id, scheduled_at);

-- Ответы (только при согласии пользователя)
CREATE TABLE answers (
  id           TEXT PRIMARY KEY,            -- UUID, создаётся на устройстве (повторная отправка безопасна)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ping_id      TEXT,                        -- NULL = запись вручную
  source       TEXT NOT NULL,               -- ping|manual
  t            INTEGER NOT NULL,            -- момент действия, ms epoch
  answered_at  INTEGER NOT NULL,
  local_date   TEXT NOT NULL,
  local_hour   INTEGER NOT NULL,
  weekday      INTEGER NOT NULL,            -- 1=пн … 7=вс
  category     TEXT NOT NULL,
  label        TEXT,                        -- своё название действия (необязательно)
  company      TEXT NOT NULL,               -- alone|pair|group
  partner      TEXT,                        -- для pair: partner|child|parent|colleague|friend|other
  d1 INTEGER NOT NULL, c1 INTEGER NOT NULL, l INTEGER NOT NULL,
  d2 TEXT, c2 TEXT,                         -- '1' | '0' | 'x' (не знаю), только для pair
  code         TEXT NOT NULL,               -- 3 знака (один/группа) или 5 знаков D1C1D2C2L
  created_at   INTEGER NOT NULL
);
CREATE INDEX answers_user ON answers(user_id, t);
CREATE INDEX answers_code ON answers(code);
