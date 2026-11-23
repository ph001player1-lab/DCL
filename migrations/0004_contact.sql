-- «Связь»: профили (имя + код входа), переписка, запись на консультацию, вход администратора.

-- Профиль: только имя. Почты и телефона нет. Сам код входа не хранится — только его SHA-256.
CREATE TABLE profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
ALTER TABLE users ADD COLUMN profile_id TEXT;                              -- устройство вошло в профиль
ALTER TABLE users ADD COLUMN login_fails INTEGER NOT NULL DEFAULT 0;       -- неверные коды подряд
ALTER TABLE users ADD COLUMN login_block_until INTEGER NOT NULL DEFAULT 0; -- пауза после 5 неверных кодов
CREATE INDEX users_profile ON users(profile_id);

-- Переписка: техподдержка, идеи, вопрос специалисту
CREATE TABLE threads (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,      -- устройство, с которого начата
  profile_id    TEXT,               -- с профилем переписка видна на всех его устройствах
  topic         TEXT NOT NULL,      -- support | idea | specialist
  status        TEXT NOT NULL DEFAULT 'new', -- support/specialist: new|open|done; idea: new|accepted|in_progress|done|declined
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_from     TEXT,               -- user | admin | system
  unread_user   INTEGER NOT NULL DEFAULT 0,
  unread_admin  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_user ON threads(user_id);
CREATE INDEX threads_profile ON threads(profile_id);
CREATE INDEX threads_updated ON threads(updated_at);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  user_id     TEXT,                 -- устройство автора (ограничение частоты); NULL у администратора
  author      TEXT NOT NULL,        -- user | admin | system
  kind        TEXT NOT NULL DEFAULT 'text', -- text | report | booking | booking_cancel | status
  body        TEXT NOT NULL DEFAULT '',
  data        TEXT,                 -- JSON: снимок анализа, запись, статус
  created_at  INTEGER NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, created_at);
CREATE INDEX messages_user ON messages(user_id, created_at);

-- Запись на консультацию (только с профилем)
CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  thread_id      TEXT,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'booked', -- booked | cancelled
  gcal_event_id  TEXT,
  meet_url       TEXT,
  reminded       INTEGER NOT NULL DEFAULT 0,      -- 1 = напоминание за час отправлено
  created_at     INTEGER NOT NULL
);
CREATE INDEX bookings_profile ON bookings(profile_id);
CREATE INDEX bookings_start ON bookings(start_at);
CREATE UNIQUE INDEX bookings_slot ON bookings(start_at) WHERE status = 'booked';

-- Администратор: сессии после входа через Google, push на его телефон, настройки
CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  via         TEXT NOT NULL
);
CREATE TABLE admin_push (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL   -- JSON
);
