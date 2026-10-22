-- Additive catalogue fields. Historical order snapshots and client IDs stay unchanged.
alter table public.products
  add column photos jsonb not null default '[]' check(jsonb_typeof(photos)='array' and jsonb_array_length(photos)<=10),
  add column composition text not null default '' check(length(composition)<=3000),
  add column care text not null default '' check(length(care)<=3000),
  add column delivery_min_days integer not null default 8 check(delivery_min_days between 1 and 120),
  add column delivery_max_days integer not null default 10 check(delivery_max_days between delivery_min_days and 120),
  add column delivery_note text not null default '' check(length(delivery_note)<=500),
  add column related_ids bigint[] not null default '{}' check(cardinality(related_ids)<=24 and not(id=any(related_ids)));
update public.products set photos=jsonb_build_array(photo) where photo is not null and photo<>'';

-- One transaction for product fields and reciprocal recommendations. The advisory lock
-- serializes rare admin edits so two editors cannot lose each other's reverse links.
create function public.ramp_save_catalog_product(p_uid bigint,p_id bigint,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare item public.products; previous_ids bigint[]; next_ids bigint[]; target bigint;
begin
  if not exists(select 1 from public.admins where telegram_id=p_uid) then raise exception 'Нет доступа'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or exists(
    select 1 from jsonb_object_keys(p_data) k where k not in
    ('name','category','price','description','active','in_stock','sku','options','specs','photo','photos','composition','care','delivery_min_days','delivery_max_days','delivery_note','related_ids')
  ) then raise exception 'Неверные поля товара'; end if;
  perform pg_advisory_xact_lock(842115);
  if p_id is null then
    insert into public.products(name,price) values(p_data->>'name',(p_data->>'price')::integer) returning * into item;
  else
    select * into item from public.products where id=p_id for update;
    if not found then raise exception 'Товар не найден'; end if;
  end if;
  previous_ids:=item.related_ids;
  item:=jsonb_populate_record(item,p_data-'related_ids');
  next_ids:=previous_ids;
  if p_data ? 'related_ids' then
    if jsonb_typeof(p_data->'related_ids') is distinct from 'array' or jsonb_array_length(p_data->'related_ids')>24 then raise exception 'Не больше 24 похожих товаров'; end if;
    select coalesce(array_agg(value::bigint order by ord),'{}') into next_ids from jsonb_array_elements_text(p_data->'related_ids') with ordinality a(value,ord);
    if item.id=any(next_ids) or array_position(next_ids,null) is not null or
      cardinality(next_ids)<>(select count(distinct n) from unnest(next_ids) n) then raise exception 'Проверьте похожие товары'; end if;
    if (select count(*) from public.products where id=any(next_ids))<>cardinality(next_ids) then raise exception 'Похожий товар не найден'; end if;
    foreach target in array next_ids loop
      if not exists(select 1 from public.products where id=target and item.id=any(related_ids)) and
        (select cardinality(related_ids) from public.products where id=target)>=24 then raise exception 'У одного из выбранных товаров уже 24 связи'; end if;
    end loop;
  end if;
  update public.products set name=item.name,category=item.category,price=item.price,description=item.description,
    active=item.active,in_stock=item.in_stock,sku=item.sku,options=item.options,specs=item.specs,photo=item.photo,
    photos=item.photos,composition=item.composition,care=item.care,delivery_min_days=item.delivery_min_days,
    delivery_max_days=item.delivery_max_days,delivery_note=item.delivery_note,related_ids=next_ids
    where id=item.id returning * into item;
  if p_data ? 'related_ids' then
    update public.products set related_ids=array_remove(related_ids,item.id)
      where id=any(previous_ids) and not(id=any(next_ids));
    update public.products set related_ids=array_append(related_ids,item.id)
      where id=any(next_ids) and not(item.id=any(related_ids));
  end if;
  return to_jsonb(item);
end $$;
revoke all on function public.ramp_save_catalog_product(bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.ramp_save_catalog_product(bigint,bigint,jsonb) to service_role;

-- Only paid orders contribute; only approved product reviews affect rating.
-- Server-only: callers never receive order/customer rows, only product totals.
create function public.ramp_catalog_ranking() returns table(product_id bigint,sold bigint,rating numeric,review_count bigint)
language sql stable security invoker set search_path=public,pg_temp as $$
  with sales as (
    select (i->>'product_id')::bigint product_id,sum((i->>'qty')::bigint)::bigint sold
    from public.orders o cross join lateral jsonb_array_elements(o.items) i
    where o.status in ('paid','bought','shipping','arrived','delivered')
      and (i->>'product_id') ~ '^[0-9]{1,15}$' and (i->>'qty') ~ '^[0-9]{1,5}$'
    group by 1
  ), reviews as (
    select product_id,round(avg(rating),2) rating,count(*) review_count from public.product_reviews
    where status='approved' and product_id is not null group by product_id
  )
  select p.id,coalesce(s.sold,0),coalesce(r.rating,0),coalesce(r.review_count,0)
  from public.products p left join sales s on s.product_id=p.id left join reviews r on r.product_id=p.id
  where p.active;
$$;
revoke all on function public.ramp_catalog_ranking() from public,anon,authenticated;
grant execute on function public.ramp_catalog_ranking() to service_role;

alter table public.content_uploads drop constraint content_uploads_scope_check;
alter table public.content_uploads add constraint content_uploads_scope_check check(scope in ('news','review','faq'));
create table public.shop_faq (
  id bigint generated always as identity primary key,
  question text not null check(length(trim(question)) between 3 and 200),
  answer text not null default '' check(length(answer)<=6000),
  media jsonb not null default '[]' check(jsonb_typeof(media)='array' and jsonb_array_length(media)<=5),
  published boolean not null default false,
  position integer not null default 0 check(position between -10000 and 10000),
  created_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shop_faq enable row level security;
revoke all on public.shop_faq from public,anon,authenticated;
grant all on public.shop_faq to service_role;
grant usage,select on sequence public.shop_faq_id_seq to service_role;
create index shop_faq_published_position_idx on public.shop_faq(position,id) where published;

create function public.ramp_save_faq(p_uid bigint,p_id bigint,p_question text,p_answer text,p_published boolean,p_position integer,p_media jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare item public.shop_faq;
begin
  if not exists(select 1 from public.admins where telegram_id=p_uid) then raise exception 'Нет доступа'; end if;
  if length(trim(p_question)) not between 3 and 200 or length(p_answer)>6000 or abs(p_position)>10000 then raise exception 'Проверьте вопрос, ответ и порядок'; end if;
  if p_id is null then
    insert into public.shop_faq(question,created_by) values(trim(p_question),p_uid) returning * into item;
  else
    select * into item from public.shop_faq where id=p_id for update;
    if not found then raise exception 'Вопрос не найден'; end if;
  end if;
  if coalesce(length(trim(p_answer)),0)=0 and jsonb_array_length(coalesce(p_media,'[]'))=0 then raise exception 'Добавьте текст или видеоответ'; end if;
  update public.shop_faq set question=trim(p_question),answer=p_answer,published=p_published,position=p_position,
    media=public.ramp_attach_content_media(p_uid,'faq',coalesce(p_media,'[]'),item.id),updated_at=now()
    where id=item.id returning * into item;
  return to_jsonb(item);
end $$;
revoke all on function public.ramp_save_faq(bigint,bigint,text,text,boolean,integer,jsonb) from public,anon,authenticated;
grant execute on function public.ramp_save_faq(bigint,bigint,text,text,boolean,integer,jsonb) to service_role;

insert into public.shop_faq(question,answer,published,position) values
('Как заказать?','Выберите товар, укажите нужные параметры и добавьте его в корзину. Откройте корзину, заполните данные получателя и подтвердите заказ. Затем оплатите его по реквизитам в разделе «Заказы» и прикрепите скриншот чека. После проверки оплаты начнём работу с заказом.',true,10),
('Куда осуществляется доставка?','По Ташкенту доставляем курьером на ваш адрес. Возможность, стоимость и сроки доставки в регионы уточняйте отдельно у администратора @ramphelper.',true,20),
('Сколько ждать заказ?','Ориентировочный срок по Ташкенту — 8–10 дней. Для отдельных товаров, включая товары с ограничениями на авиаперевозку, срок может достигать 21–24 дней. Ориентир указан на кнопке добавления в корзину и в карточке товара. Точную дату и условия уточните у @ramphelper.',true,30),
('Как оплатить заказ?','Оплата производится переводом на номер карты, указанный в вашем заказе. После перевода откройте «Заказы», выберите заказ и прикрепите скриншот чека. Администратор проверит оплату и обновит статус.',true,40),
('Как отследить доставку?','Откройте раздел «Заказы»: там видны текущий статус и трек-номер, если он уже добавлен. Ваш постоянный личный ID находится в профиле — укажите его и номер заказа при обращении в поддержку.',true,50),
('Сколько стоит доставка?','Стоимость и условия доставки уточняйте у @ramphelper перед оплатой. Для доставки в регионы условия согласовываются отдельно.',true,60),
('Как отменить заказ или оформить возврат?','Напишите @ramphelper и укажите номер заказа и личный ID из профиля. Поддержка уточнит этап заказа, возможность отмены или возврата и дальнейшие действия.',true,70);
