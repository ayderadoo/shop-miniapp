-- Совместимость с рабочей базой и атомарные операции. Вызов RPC только с service_role.
alter table public.products add column if not exists options jsonb not null default '[]',
  add column if not exists specs jsonb not null default '[]';
alter table public.cart_items add column if not exists opts jsonb not null default '{}',
  add column if not exists variant text not null default '';
alter table public.cart_items drop constraint if exists cart_items_pkey;
alter table public.cart_items add primary key (telegram_id, product_id, variant);
alter table public.orders add column if not exists request_id uuid;
create unique index if not exists orders_request_id_idx on public.orders(telegram_id, request_id) where request_id is not null;

-- Существующие ID не меняются. Sequence исключает коллизии при одновременной регистрации.
create sequence if not exists public.ramp_public_id_seq;
select setval('public.ramp_public_id_seq', greatest(100000,
  coalesce((select max(substring(public_id from 6)::bigint) + 1 from public.profiles where public_id ~ '^RAMP-[0-9]{6,18}$'), 100000)), false);
create or replace function public.gen_public_id() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare n text;
begin
  if new.public_id is null then
    loop
      n := nextval('public.ramp_public_id_seq')::text;
      new.public_id := 'RAMP-' || case when length(n) < 6 then lpad(n,6,'0') else n end;
      exit when not exists(select 1 from public.profiles where public_id = new.public_id);
    end loop;
  end if;
  return new;
end $$;
revoke all on sequence public.ramp_public_id_seq from public, anon, authenticated;
grant usage, select on sequence public.ramp_public_id_seq to service_role;
revoke all on function public.gen_public_id() from public, anon, authenticated;

create table if not exists public.bot_updates (
  bot_kind text not null check (bot_kind in ('shop','admin')),
  update_id bigint not null,
  processed boolean not null default false,
  claimed_at timestamptz not null default now(),
  primary key (bot_kind, update_id)
);
alter table public.bot_updates enable row level security;
revoke all on public.bot_updates from public, anon, authenticated;
grant all on public.bot_updates to service_role;

create or replace function public.ramp_claim_update(p_bot text, p_update_id bigint) returns text
language plpgsql set search_path = public, pg_temp as $$
declare u public.bot_updates;
begin
  insert into public.bot_updates(bot_kind,update_id) values(p_bot,p_update_id) on conflict do nothing;
  if found then return 'claimed'; end if;
  select * into u from public.bot_updates where bot_kind=p_bot and update_id=p_update_id for update;
  if u.processed then return 'done'; end if;
  if u.claimed_at > now() - interval '90 seconds' then return 'busy'; end if;
  update public.bot_updates set claimed_at=now() where bot_kind=p_bot and update_id=p_update_id;
  return 'claimed';
end $$;

create or replace function public.ramp_apply_referral(p_uid bigint, p_code text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare buyer public.profiles; inviter public.profiles;
begin
  -- Сериализация привязок исключает циклы даже при одновременных запросах.
  perform pg_advisory_xact_lock(72418031);
  select * into buyer from public.profiles where telegram_id=p_uid for update;
  if not found or buyer.blocked then raise exception 'Профиль недоступен'; end if;
  select * into inviter from public.profiles where public_id=upper(trim(p_code));
  if not found or inviter.blocked then raise exception 'Пользователь с таким ID не найден'; end if;
  if inviter.telegram_id=p_uid then raise exception 'Нельзя указать собственный ID'; end if;
  if buyer.referred_by=inviter.telegram_id then return jsonb_build_object('changed',false,'referrer',inviter.telegram_id); end if;
  if buyer.referred_by is not null then raise exception 'Код друга уже указан'; end if;
  if exists(select 1 from public.orders where telegram_id=p_uid and status<>'cancelled') then
    raise exception 'Код друга можно указать только до первого заказа';
  end if;
  if exists(with recursive chain(id) as (
    select inviter.telegram_id union select p.referred_by from public.profiles p join chain c on p.telegram_id=c.id where p.referred_by is not null
  ) select 1 from chain where id=p_uid) then raise exception 'Это приглашение создаёт замкнутую цепочку'; end if;
  update public.profiles set referred_by=inviter.telegram_id,referred_at=now() where telegram_id=p_uid;
  return jsonb_build_object('changed',true,'referrer',inviter.telegram_id);
end $$;

create or replace function public.ramp_create_order(p_uid bigint, p_request_id uuid, p_details jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  buyer public.profiles; o public.orders; coupon public.coupons; r record;
  promo jsonb; payments jsonb; cards jsonb; items jsonb := '[]'; option jsonb; choice jsonb;
  price bigint; subtotal bigint := 0; pct int := 0; discount int; reason text; variant_text text;
  full_name text := regexp_replace(trim(coalesce(p_details->>'full_name','')), '\s+', ' ', 'g');
  phone text := trim(coalesce(p_details->>'phone','')); city text := trim(coalesce(p_details->>'city',''));
  street text := trim(coalesce(p_details->>'address','')); payment text := p_details->>'payment_method';
  card text; welcome_pct int; welcome_days int;
begin
  if p_request_id is null then raise exception 'Не указан номер запроса'; end if;
  select * into buyer from public.profiles where telegram_id=p_uid for update;
  if not found or buyer.blocked then raise exception 'Профиль недоступен'; end if;
  select * into o from public.orders where telegram_id=p_uid and request_id=p_request_id;
  if found then return jsonb_build_object('order',to_jsonb(o),'created',false); end if;
  if coalesce(buyer.tg_phone,'')='' then raise exception 'Подтвердите номер телефона в основном боте'; end if;
  if full_name !~ '\S+\s+\S+' or length(full_name)>120 then raise exception 'Укажите фамилию и имя получателя'; end if;
  if length(regexp_replace(phone,'\D','','g'))<9 or length(phone)>30 then raise exception 'Укажите телефон получателя'; end if;
  if city='' or length(city)>60 or length(street)<5 or length(street)>300 then raise exception 'Укажите город и полный адрес'; end if;
  select value into promo from public.settings where key='promo';
  select value into payments from public.settings where key='payments';
  select value into cards from public.settings where key='payment_cards';
  if not coalesce(payments ? payment,false) then raise exception 'Выберите способ оплаты'; end if;
  if cards is null or jsonb_array_length(cards)=0 then raise exception 'Реквизиты оплаты пока не настроены'; end if;
  welcome_pct := coalesce((promo->>'welcomePct')::int,10); welcome_days := coalesce((promo->>'welcomeDays')::int,30);
  if buyer.created_at + make_interval(days=>welcome_days)>now() then pct:=welcome_pct; reason:='Приветственная скидка'; end if;
  select * into coupon from public.coupons c where c.telegram_id=p_uid and c.used_order_id is null
    order by c.pct desc,c.id limit 1 for update;
  if found and coupon.pct>pct then pct:=coupon.pct; reason:='Купон'; else coupon:=null; end if;
  if pct<0 or pct>90 then raise exception 'Проверьте настройки скидок'; end if;

  for r in select c.product_id,c.qty,c.opts,c.variant,p.name,p.price,p.photo,p.options
    from public.cart_items c join public.products p on p.id=c.product_id
    where c.telegram_id=p_uid and p.active and p.in_stock order by p.id,c.variant for update of c for share of p
  loop
    price:=r.price; variant_text:='';
    for option in select value from jsonb_array_elements(r.options) loop
      choice:=null;
      select value into choice from jsonb_array_elements(option->'values') where value->>'label'=r.opts->>(option->>'name') limit 1;
      if choice is null then raise exception 'Параметры товара «%» изменились. Выберите их заново',r.name; end if;
      if variant_text<>'' then variant_text:=variant_text || ', '; end if;
      variant_text:=variant_text || (option->>'name') || ': ' || (choice->>'label');
      price:=price+coalesce((choice->>'add')::bigint,0);
    end loop;
    if variant_text<>r.variant then raise exception 'Параметры товара «%» изменились. Выберите их заново',r.name; end if;
    if price<1 or price>100000000 then raise exception 'Неверная цена товара'; end if;
    subtotal:=subtotal+price*r.qty;
    items:=items || jsonb_build_array(jsonb_build_object('product_id',r.product_id,'name',r.name,'price',price,'qty',r.qty,'photo',r.photo,'variant',r.variant));
  end loop;
  if jsonb_array_length(items)=0 then raise exception 'В корзине нет доступных товаров'; end if;
  if subtotal>2000000000 then raise exception 'Сумма заказа слишком большая'; end if;
  discount:=round(subtotal*pct/100.0);
  card:=cards->>(floor(random()*jsonb_array_length(cards))::int);
  insert into public.orders(telegram_id,request_id,items,subtotal,discount_pct,discount_amount,discount_reason,coupon_id,total,
    full_name,phone,address,comment,payment_method,pay_card)
  values(p_uid,p_request_id,items,subtotal,pct,discount,reason,coupon.id,subtotal-discount,
    full_name,phone,city || ', ' || street,left(p_details->>'comment',500),payment,card) returning * into o;
  if coupon.id is not null then update public.coupons set used_order_id=o.id,used_at=now() where id=coupon.id; end if;
  delete from public.cart_items c using jsonb_array_elements(items) i
    where c.telegram_id=p_uid and c.product_id=(i->>'product_id')::bigint and c.variant=i->>'variant';
  update public.profiles set full_name=ramp_create_order.full_name,phone=ramp_create_order.phone,city=ramp_create_order.city,
    address=street,updated_at=now() where telegram_id=p_uid;
  return jsonb_build_object('order',to_jsonb(o),'created',true);
end $$;

create or replace function public.ramp_set_order_status(p_order_id bigint, p_status text, p_reason text default '', p_expected text default null) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare o public.orders; buyer public.profiles; promo jsonb; rewards jsonb:='[]'; r public.coupons; uid bigint;
begin
  select telegram_id into uid from public.orders where id=p_order_id;
  if not found then return null; end if;
  select * into buyer from public.profiles where telegram_id=uid for update;
  select * into o from public.orders where id=p_order_id for update;
  if p_expected is not null and o.status<>p_expected then raise exception 'Заказ уже обработан. Обновите список'; end if;
  if o.status=p_status then return jsonb_build_object('order',to_jsonb(o),'changed',false); end if;
  if not ((o.status='new' and p_status in ('paid','cancelled')) or
    (o.status='review' and p_status in ('new','paid','cancelled')) or
    (o.status='paid' and p_status in ('bought','cancelled')) or
    (o.status='bought' and p_status='shipping') or (o.status='shipping' and p_status='arrived') or
    (o.status='arrived' and p_status='delivered')) then raise exception 'Недопустимый переход статуса заказа'; end if;
  update public.orders set status=p_status,reject_reason=case when p_status='new' then left(p_reason,300) else null end,
    updated_at=now() where id=p_order_id returning * into o;
  if p_status='cancelled' then update public.coupons set used_order_id=null,used_at=null where used_order_id=o.id; end if;
  if p_status='paid' and not buyer.ref_rewarded and buyer.referred_by is not null then
    select value into promo from public.settings where key='promo';
    if o.subtotal>=coalesce((promo->>'minQualifyingOrder')::int,200000) then
      if coalesce((promo->>'inviterPct')::int,33)>0 then
        insert into public.coupons(telegram_id,pct,reason,source_order_id) values(buyer.referred_by,coalesce((promo->>'inviterPct')::int,33),'ref_inviter',o.id)
          returning * into r;
        rewards:=rewards || jsonb_build_array(to_jsonb(r));
      end if;
      if coalesce((promo->>'inviteeNextPct')::int,11)>0 then
        insert into public.coupons(telegram_id,pct,reason,source_order_id) values(uid,coalesce((promo->>'inviteeNextPct')::int,11),'ref_invitee',o.id)
          returning * into r;
        rewards:=rewards || jsonb_build_array(to_jsonb(r));
      end if;
      update public.profiles set ref_rewarded=true where telegram_id=uid;
    end if;
  end if;
  return jsonb_build_object('order',to_jsonb(o),'changed',true,'rewards',rewards);
end $$;

revoke all on function public.ramp_claim_update(text,bigint),public.ramp_apply_referral(bigint,text),
  public.ramp_create_order(bigint,uuid,jsonb),public.ramp_set_order_status(bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.ramp_claim_update(text,bigint),public.ramp_apply_referral(bigint,text),
  public.ramp_create_order(bigint,uuid,jsonb),public.ramp_set_order_status(bigint,text,text,text) to service_role;

create index if not exists orders_owner_created_idx on public.orders(telegram_id,created_at desc);
create index if not exists orders_status_created_idx on public.orders(status,created_at desc);
create index if not exists photo_requests_owner_created_idx on public.photo_requests(telegram_id,created_at desc);

create or replace function public.ramp_admin_stats() returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'byStatus',coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.orders group by status) s),'{}'::jsonb),
    'users',(select count(*) from public.profiles),
    'newRequests',(select count(*) from public.photo_requests where status='new'),
    'revenue30',(select coalesce(sum(total),0) from public.orders where status in ('paid','bought','shipping','arrived','delivered') and created_at>=now()-interval '30 days'),
    'paid30',(select count(*) from public.orders where status in ('paid','bought','shipping','arrived','delivered') and created_at>=now()-interval '30 days')
  );
$$;
revoke all on function public.ramp_admin_stats() from public,anon,authenticated;
grant execute on function public.ramp_admin_stats() to service_role;
