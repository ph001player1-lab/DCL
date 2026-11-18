-- Анонимные сведения об устройстве для админки: платформа и «установлено как приложение».
ALTER TABLE users ADD COLUMN platform TEXT;      -- android | ios | desktop | other
ALTER TABLE users ADD COLUMN standalone INTEGER; -- 1 = открыто как установленное приложение, 0 = в браузере
CREATE INDEX users_seen ON users(last_seen);
