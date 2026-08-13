-- Kullanıcı 'murat' admin yapılıyor
UPDATE users SET role = 'admin' WHERE username = 'murat';

-- Bekleyen TD başvurularını göster (kontrol için)
SELECT * FROM national_manager_applications WHERE status = 'pending';

-- 'murat' kullanıcısının başvurusunu onayla
UPDATE national_manager_applications SET status = 'approved' 
WHERE user_id = (SELECT id FROM users WHERE username = 'murat');
