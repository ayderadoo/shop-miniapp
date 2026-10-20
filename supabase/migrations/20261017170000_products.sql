-- Таблица товаров. Создана вручную через SQL Editor до появления миграций.
create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null,
  category text,
  price integer not null,
  photo text,
  description text,
  active boolean default true,
  created_at timestamptz default now()
);

alter table public.products enable row level security;

-- Покупатели (anon) видят только активные товары; изменения — только через service role
create policy "public read active products"
on public.products for select
using (active = true);
