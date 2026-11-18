-- Уточнение «нельзя» (L = 0): что именно нарушено.
ALTER TABLE answers ADD COLUMN l_kind TEXT; -- law (закон) | rules (правила места или работы) | norms (нормы круга); NULL, если L = 1
