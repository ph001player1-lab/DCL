-- Обратная связь от тех, кто перестал пользоваться: одно уведомление на устройство и ответы.
ALTER TABLE users ADD COLUMN feedback_asked_at INTEGER; -- когда отправили «помогите нам стать лучше» (только один раз)
ALTER TABLE users ADD COLUMN push_gone_at INTEGER;      -- когда сервис уведомлений ответил «подписки больше нет»
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,       -- случайный номер устройства, без имени
  created_at  INTEGER NOT NULL,
  reasons     TEXT NOT NULL DEFAULT '', -- через запятую: often,time,forget,unclear,hard,nouse,break,other
  text        TEXT,                -- своими словами (необязательно); копия уходит в «Сообщения»
  action      TEXT,                -- быстрое решение: fewer | pause | off
  asked       INTEGER NOT NULL DEFAULT 0 -- 1 = ответ после уведомления
);
CREATE INDEX feedback_user ON feedback(user_id);
