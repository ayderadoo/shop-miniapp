-- Видео в поиске по фото — до 50 МБ (до 20 МБ админы получают видео прямо в боте, больше — ссылкой).
update storage.buckets set file_size_limit=52428800 where id='requests';
