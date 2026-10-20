-- Примечание: ранги и бонусы (bonus_balance, rank_discount, ref_discount, bonus_used,
-- ref_bonus_paid, bonus_refunded, add_bonus) позже убраны из логики и больше не используются.
alter table public.profiles
  add column if not exists public_id text unique,
  add column if not exists tg_phone text,
  add column if not exists referred_by bigint references public.profiles(telegram_id),
  add column if not exists referred_at timestamptz,
  add column if not exists bonus_balance integer not null default 0 check (bonus_balance >= 0),
  add column if not exists catalog_view text not null default 'grid' check (catalog_view in ('grid','list'));

create or replace function public.gen_public_id() returns trigger
language plpgsql set search_path = public as $$
declare cand text;
begin
  if new.public_id is null then
    loop
      cand := 'RAMP-' || lpad((floor(random() * 1000000))::int::text, 6, '0');
      exit when not exists (select 1 from public.profiles where public_id = cand);
    end loop;
    new.public_id := cand;
  end if;
  return new;
end $$;

create trigger profiles_public_id before insert on public.profiles
for each row execute function public.gen_public_id();

do $$
declare r record; cand text;
begin
  for r in select telegram_id from public.profiles where public_id is null loop
    loop
      cand := 'RAMP-' || lpad((floor(random() * 1000000))::int::text, 6, '0');
      exit when not exists (select 1 from public.profiles where public_id = cand);
    end loop;
    update public.profiles set public_id = cand where telegram_id = r.telegram_id;
  end loop;
end $$;

create or replace function public.add_bonus(p_tg bigint, p_delta integer) returns integer
language sql set search_path = public as $$
  update public.profiles set bonus_balance = bonus_balance + p_delta
  where telegram_id = p_tg and bonus_balance + p_delta >= 0
  returning bonus_balance;
$$;

revoke execute on function public.add_bonus(bigint, integer) from public, anon, authenticated;
revoke execute on function public.gen_public_id() from public, anon, authenticated;

alter table public.orders
  add column if not exists subtotal integer,
  add column if not exists rank_discount integer not null default 0,
  add column if not exists ref_discount integer not null default 0,
  add column if not exists bonus_used integer not null default 0,
  add column if not exists payment_method text,
  add column if not exists ref_bonus_paid boolean not null default false,
  add column if not exists bonus_refunded boolean not null default false;

update public.orders set subtotal = total where subtotal is null;

create index if not exists profiles_referred_by_idx on public.profiles(referred_by);
