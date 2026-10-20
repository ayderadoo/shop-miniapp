create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;

create table if not exists public.admins (
  telegram_id bigint primary key,
  name text,
  added_by bigint,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- Какое сообщение в чате какого админа относится к какому заказу/заявке (для ответов свайпом)
create table if not exists public.admin_messages (
  chat_id bigint not null,
  message_id bigint not null,
  kind text not null check (kind in ('order','photo')),
  ref_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
alter table public.admin_messages enable row level security;

alter table public.profiles
  add column if not exists note text,
  add column if not exists blocked boolean not null default false;

insert into public.admins (telegram_id) values (5796105755), (1141623630), (1393385884)
on conflict do nothing;

insert into public.settings (key, value) values
  ('promo', '{"welcomePct":10,"welcomeDays":30,"inviterPct":33,"inviteeNextPct":11,"minQualifyingOrder":200000}'),
  ('payments', '{"card":"Перевод на карту (Humo / Uzcard)","click":"Click","payme":"Payme","uzum":"Uzum Bank"}')
on conflict (key) do nothing;

-- Токен бота хранится в settings (key = 'bot_token') и НЕ попадает в репозиторий.
-- Задать: insert into public.settings (key, value) values ('bot_token', to_jsonb('<ТОКЕН>'::text))
--         on conflict (key) do update set value = excluded.value;
