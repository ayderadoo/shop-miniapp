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
  update public.profiles set full_name=regexp_replace(trim(p_details->>'full_name'), '\s+', ' ', 'g'),phone=trim(p_details->>'phone'),city=trim(p_details->>'city'),
    address=street,updated_at=now() where telegram_id=p_uid;
  return jsonb_build_object('order',to_jsonb(o),'created',true);
end $$;

