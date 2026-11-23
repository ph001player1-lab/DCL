-- Заявки специалистов с сайта (/specialists/): имя и контакт для ответа вне приложения.
ALTER TABLE threads ADD COLUMN guest_name TEXT;
ALTER TABLE threads ADD COLUMN guest_contact TEXT;
