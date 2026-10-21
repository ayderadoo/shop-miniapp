alter table public.products add column if not exists sku text;
create unique index if not exists products_sku_unique on public.products(lower(sku)) where sku is not null;
update public.products set sku='TEST-' || id where sku is null and name like '%(тест)';
alter table public.profiles add column if not exists delivery_id text,
  add column if not exists phone_verified_at timestamptz;
update public.profiles set delivery_id='RAMP-D' || case when length(user_no::text)<6 then lpad(user_no::text,6,'0') else user_no::text end where delivery_id is null;
create unique index if not exists profiles_delivery_id_unique on public.profiles(delivery_id);
update public.profiles set phone_verified_at=updated_at where tg_phone ~ '^\+998[0-9]{9}$' and phone_verified_at is null;
create table public.client_identifiers (
  telegram_id bigint primary key references public.profiles(telegram_id),
  public_id text not null unique,
  delivery_id text not null unique,
  issued_at timestamptz not null default now()
);
insert into public.client_identifiers(telegram_id,public_id,delivery_id,issued_at)
  select telegram_id,public_id,delivery_id,created_at from public.profiles;
alter table public.client_identifiers enable row level security;
revoke all on public.client_identifiers from public,anon,authenticated;
grant select,insert on public.client_identifiers to service_role;
create or replace function public.ramp_assign_delivery_id() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' then
    if new.public_id is distinct from old.public_id or new.delivery_id is distinct from old.delivery_id or new.user_no is distinct from old.user_no then
      raise exception 'Выданный ID клиента нельзя менять';
    end if;
  else
    new.delivery_id:='RAMP-D' || case when length(new.user_no::text)<6 then lpad(new.user_no::text,6,'0') else new.user_no::text end;
  end if;
  return new;
end $$;
create trigger profiles_delivery_id before insert or update on public.profiles for each row execute function public.ramp_assign_delivery_id();
create or replace function public.ramp_register_ids() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  insert into public.client_identifiers(telegram_id,public_id,delivery_id,issued_at) values(new.telegram_id,new.public_id,new.delivery_id,new.created_at);
  return new;
end $$;
create trigger profiles_id_registry after insert on public.profiles for each row execute function public.ramp_register_ids();
revoke all on function public.ramp_assign_delivery_id(),public.ramp_register_ids() from public,anon,authenticated;

alter table public.orders add column if not exists delivery_id text,
  add column if not exists tracking_number text,
  add column if not exists delivery_note text,
  add column if not exists search_items text generated always as (items::text) stored;
update public.orders o set delivery_id=p.delivery_id from public.profiles p where p.telegram_id=o.telegram_id and o.delivery_id is null;

create table public.shop_news (
  id bigint generated always as identity primary key,
  title text not null check(length(title) between 1 and 160),
  body text not null default '' check(length(body)<=6000),
  published boolean not null default false,
  pinned boolean not null default false,
  position integer not null default 0,
  media jsonb not null default '[]' check(jsonb_typeof(media)='array' and jsonb_array_length(media)<=5),
  created_by bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.product_reviews (
  id bigint generated always as identity primary key,
  telegram_id bigint not null,
  product_id bigint references public.products(id),
  author_name text not null check(length(author_name) between 1 and 80),
  rating integer not null check(rating between 1 and 5),
  body text not null default '' check(length(body)<=3000),
  source text not null check(source in ('customer','store')),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  media jsonb not null default '[]' check(jsonb_typeof(media)='array' and jsonb_array_length(media)<=5),
  verified_purchase boolean not null default false,
  moderation_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index reviews_customer_product_unique on public.product_reviews(telegram_id,coalesce(product_id,0)) where source='customer';
create index reviews_public_product_idx on public.product_reviews(product_id,created_at desc) where status='approved';
create index reviews_moderation_idx on public.product_reviews(status,created_at desc);
create index news_published_idx on public.shop_news(pinned desc,position,created_at desc) where published;
create table public.content_uploads (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  scope text not null check(scope in ('news','review')),
  path text not null unique,
  mime text not null,
  size bigint not null check(size between 1 and 26214400),
  attached_id bigint,
  created_at timestamptz not null default now()
);
create index content_uploads_owner_time_idx on public.content_uploads(telegram_id,created_at desc);
alter table public.shop_news enable row level security;
alter table public.product_reviews enable row level security;
alter table public.content_uploads enable row level security;
revoke all on public.shop_news,public.product_reviews,public.content_uploads from public,anon,authenticated;
grant all on public.shop_news,public.product_reviews,public.content_uploads to service_role;
grant usage,select on sequence public.shop_news_id_seq,public.product_reviews_id_seq to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('shop-content','shop-content',false,26214400,array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
 on conflict(id) do nothing;

create or replace function public.ramp_attach_content_media(p_uid bigint,p_scope text,p_ids jsonb,p_resource bigint) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare result jsonb:='[]'; upload public.content_uploads; item jsonb; metadata jsonb;
begin
  if jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids)>5 then raise exception 'Не больше пяти файлов'; end if;
  if (select count(distinct value) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'Файл повторяется'; end if;
  for item in select value from jsonb_array_elements(p_ids) loop
    select * into upload from public.content_uploads where id=(item#>>'{}')::uuid and scope=p_scope and (telegram_id=p_uid or (attached_id=p_resource and exists(select 1 from public.admins where telegram_id=p_uid))) for update;
    if not found or (upload.attached_id is not null and upload.attached_id<>p_resource) then raise exception 'Файл не принадлежит этой записи'; end if;
    select o.metadata into metadata from storage.objects o where o.bucket_id='shop-content' and o.name=upload.path;
    if metadata is null or coalesce((metadata->>'size')::bigint,0)<1 or (metadata->>'size')::bigint>upload.size then raise exception 'Загрузка файла не завершена'; end if;
    if metadata->>'mimetype' is distinct from upload.mime then raise exception 'Формат загруженного файла не совпадает'; end if;
    update public.content_uploads set attached_id=p_resource where id=upload.id;
    result:=result || jsonb_build_array(jsonb_build_object('upload_id',upload.id,'path',upload.path,'mime',upload.mime));
  end loop;
  return result;
end $$;

create or replace function public.ramp_save_news(p_uid bigint,p_id bigint,p_title text,p_body text,p_published boolean,p_pinned boolean,p_position integer,p_media jsonb) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare item public.shop_news;
begin
  if not exists(select 1 from public.admins where telegram_id=p_uid) then raise exception 'Нет доступа'; end if;
  if length(trim(p_title)) not between 1 and 160 or length(p_body)>6000 then raise exception 'Проверьте заголовок и текст'; end if;
  if p_id is null then
    insert into public.shop_news(title,created_by) values(trim(p_title),p_uid) returning * into item;
  else
    select * into item from public.shop_news where id=p_id for update;
    if not found then raise exception 'Новость не найдена'; end if;
  end if;
  update public.shop_news set title=trim(p_title),body=p_body,published=p_published,pinned=p_pinned,position=p_position,
    media=public.ramp_attach_content_media(p_uid,'news',coalesce(p_media,'[]'),item.id),updated_at=now() where id=item.id returning * into item;
  return to_jsonb(item);
end $$;

create or replace function public.ramp_save_review(p_uid bigint,p_id bigint,p_product_id bigint,p_source text,p_author text,p_rating integer,p_body text,p_publish boolean,p_media jsonb) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare item public.product_reviews; profile public.profiles; author text; purchase boolean:=false;
begin
  if p_source='store' then
    if not exists(select 1 from public.admins where telegram_id=p_uid) then raise exception 'Нет доступа'; end if;
    author:=coalesce(nullif(trim(p_author),''),'Покупатель RAMP');
    if p_id is not null then select * into item from public.product_reviews where id=p_id and source='store' for update;
      if not found then raise exception 'Редактировать можно собственную публикацию магазина'; end if;
    end if;
  elsif p_source='customer' then
    select * into profile from public.profiles where telegram_id=p_uid for update;
    if not found or profile.blocked or coalesce(profile.tg_phone,'') !~ '^\+998[0-9]{9}$' then raise exception 'Подтвердите собственный номер Узбекистана'; end if;
    author:=left(coalesce(nullif(trim(profile.first_name),''),'Покупатель'),80);
    select * into item from public.product_reviews where telegram_id=p_uid and source='customer' and product_id is not distinct from p_product_id for update;
    if p_id is not null and (item.id is null or p_id<>item.id) then raise exception 'Отзыв не найден'; end if;
    purchase:=exists(select 1 from public.orders o where o.telegram_id=p_uid and o.status='delivered' and
      (p_product_id is null or exists(select 1 from jsonb_array_elements(o.items) i where (i->>'product_id')::bigint=p_product_id)));
  else raise exception 'Неверный тип отзыва'; end if;
  if p_product_id is not null and not exists(select 1 from public.products where id=p_product_id and active) then raise exception 'Товар не найден'; end if;
  if p_rating not between 1 and 5 or length(p_body)>3000 or (length(trim(p_body))<3 and jsonb_array_length(p_media)=0) then raise exception 'Поставьте оценку и добавьте текст или файл'; end if;
  if item.id is null then insert into public.product_reviews(telegram_id,product_id,author_name,rating,source)
    values(p_uid,p_product_id,author,p_rating,p_source) returning * into item; end if;
  update public.product_reviews set product_id=p_product_id,author_name=author,rating=p_rating,body=trim(p_body),verified_purchase=purchase,
    status=case when p_source='store' and p_publish then 'approved' else 'pending' end,moderation_note=null,
    media=public.ramp_attach_content_media(p_uid,'review',coalesce(p_media,'[]'),item.id),updated_at=now() where id=item.id returning * into item;
  return to_jsonb(item);
end $$;

revoke all on function public.ramp_attach_content_media(bigint,text,jsonb,bigint),
 public.ramp_save_news(bigint,bigint,text,text,boolean,boolean,integer,jsonb),
 public.ramp_save_review(bigint,bigint,bigint,text,text,integer,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.ramp_attach_content_media(bigint,text,jsonb,bigint),
 public.ramp_save_news(bigint,bigint,text,text,boolean,boolean,integer,jsonb),
 public.ramp_save_review(bigint,bigint,bigint,text,text,integer,text,boolean,jsonb) to service_role;

create or replace function public.ramp_review_stats(p_product_id bigint default null) returns jsonb language sql stable set search_path=public,pg_temp as $$
  select jsonb_build_object('count',count(*),'rating',coalesce(round(avg(rating),1),0)) from public.product_reviews
    where status='approved' and (p_product_id is null or product_id=p_product_id);
$$;
revoke all on function public.ramp_review_stats(bigint) from public,anon,authenticated;
grant execute on function public.ramp_review_stats(bigint) to service_role;

create or replace view public.order_procurement with(security_invoker=true) as
  select o.id,o.delivery_id,o.status,i->>'sku' as sku,i->>'name' as name,i->>'variant' as variant,
    (i->>'qty')::integer as qty,(i->>'price')::integer as unit_price,
    (i->>'qty')::bigint*(i->>'price')::bigint as total
  from public.orders o cross join lateral jsonb_array_elements(o.items) i;
revoke all on public.order_procurement from public,anon,authenticated;
grant select on public.order_procurement to service_role;

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
  if coalesce(buyer.tg_phone,'') !~ '^\+998[0-9]{9}$' then raise exception 'Подтвердите собственный номер Узбекистана в основном боте'; end if;
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

  for r in select c.product_id,c.qty,c.opts,c.variant,p.name,p.price,p.photo,p.options,p.sku
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
    items:=items || jsonb_build_array(jsonb_build_object('product_id',r.product_id,'sku',r.sku,'name',r.name,'price',price,'qty',r.qty,'photo',r.photo,'variant',r.variant));
  end loop;
  if jsonb_array_length(items)=0 then raise exception 'В корзине нет доступных товаров'; end if;
  if subtotal>2000000000 then raise exception 'Сумма заказа слишком большая'; end if;
  discount:=round(subtotal*pct/100.0);
  card:=cards->>(floor(random()*jsonb_array_length(cards))::int);
  insert into public.orders(telegram_id,request_id,items,subtotal,discount_pct,discount_amount,discount_reason,coupon_id,total,
    full_name,phone,address,comment,payment_method,pay_card,delivery_id)
  values(p_uid,p_request_id,items,subtotal,pct,discount,reason,coupon.id,subtotal-discount,
    full_name,phone,city || ', ' || street,left(p_details->>'comment',500),payment,card,buyer.delivery_id) returning * into o;
  if coupon.id is not null then update public.coupons set used_order_id=o.id,used_at=now() where id=coupon.id; end if;
  delete from public.cart_items c using jsonb_array_elements(items) i
    where c.telegram_id=p_uid and c.product_id=(i->>'product_id')::bigint and c.variant=i->>'variant';
  update public.profiles set full_name=regexp_replace(trim(p_details->>'full_name'), '\s+', ' ', 'g'),phone=trim(p_details->>'phone'),city=trim(p_details->>'city'),
    address=street,updated_at=now() where telegram_id=p_uid;
  return jsonb_build_object('order',to_jsonb(o),'created',true);
end $$;

