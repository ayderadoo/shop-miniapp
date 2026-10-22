-- Артикулы RM-600000, RM-600001…: существующие товары нумеруются по порядку.
with numbered as (select id, 599999 + row_number() over (order by id) n from public.products)
update public.products p set sku = 'RM-' || numbered.n from numbered where numbered.id = p.id;
-- RM- и число от 600000 до 999 999 999 без ведущих нулей.
alter table public.products add constraint products_sku_rm
  check (sku ~ '^RM-(6[0-9]{5}|[7-9][0-9]{5}|[1-9][0-9]{6,8})$');

-- Без артикула товар получает следующий свободный номер (под той же блокировкой, что и сохранение).
create or replace function public.ramp_save_catalog_product(p_uid bigint,p_id bigint,p_data jsonb) returns jsonb
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
  if coalesce(item.sku,'')='' then
    select 'RM-' || greatest(600000, coalesce(max(substring(sku from 4)::bigint)+1, 600000)) into item.sku
      from public.products where sku ~ '^RM-[0-9]{6,9}$' and id<>item.id;
  end if;
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
