-- Восстановлено из уже применённой миграции рабочего Supabase.
alter table public.products
  add column if not exists options jsonb not null default '[]'::jsonb,
  add column if not exists specs jsonb not null default '[]'::jsonb;
alter table public.cart_items
  add column if not exists opts jsonb not null default '{}'::jsonb,
  add column if not exists variant text not null default '';
alter table public.cart_items drop constraint if exists cart_items_pkey;
alter table public.cart_items add primary key (telegram_id, product_id, variant);
