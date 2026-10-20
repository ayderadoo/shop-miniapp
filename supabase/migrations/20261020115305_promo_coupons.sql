create table if not exists public.coupons (
  id bigint generated always as identity primary key,
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  pct integer not null check (pct > 0 and pct < 100),
  reason text not null check (reason in ('ref_inviter','ref_invitee','manual')),
  source_order_id bigint references public.orders(id),
  used_order_id bigint references public.orders(id),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_order_id, reason)
);
create index if not exists coupons_owner_idx on public.coupons(telegram_id) where used_order_id is null;
create index if not exists coupons_used_idx on public.coupons(used_order_id);
alter table public.coupons enable row level security;

alter table public.orders
  add column if not exists discount_pct integer not null default 0,
  add column if not exists discount_amount integer not null default 0,
  add column if not exists discount_reason text,
  add column if not exists coupon_id bigint references public.coupons(id);

alter table public.profiles
  add column if not exists ref_rewarded boolean not null default false;
