-- Короткие видео в поиске по фото. 20 МБ — предел, при котором Telegram сам забирает видео по ссылке для админов.
update storage.buckets set file_size_limit=20971520,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime']
  where id='requests';
alter table public.photo_requests add column media_type text not null default 'image' check (media_type in ('image','video'));
