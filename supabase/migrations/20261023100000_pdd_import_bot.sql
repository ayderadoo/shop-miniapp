-- Бот-импортёр Пиндодо: настройки расчёта и кэш товаров (TMAPI + перевод Gemini).
-- Доступ только через Edge Function pdd (service role); клиентских политик нет.
create table if not exists public.pdd_bot_settings (
  id int primary key check (id = 1),
  data jsonb not null default '{}'::jsonb
);

create table if not exists public.pdd_imports (
  goods_id bigint primary key,
  raw jsonb not null,
  ai jsonb,
  weight_kg numeric(8,3) check (weight_kg is null or weight_kg > 0),
  product_id bigint,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pdd_bot_settings enable row level security;
alter table public.pdd_imports enable row level security;
revoke all on public.pdd_bot_settings, public.pdd_imports from anon, authenticated;

-- Ключи бота (как settings.bot_token у основного бота); env функции имеет приоритет.
create table if not exists public.pdd_bot_secrets (
  name text primary key,
  value text not null
);
alter table public.pdd_bot_secrets enable row level security;
revoke all on public.pdd_bot_secrets from anon, authenticated;
