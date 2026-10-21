-- Самопроверка в под-транзакции: тестовые строки и настройки всегда откатываются.
do $$
declare
  a bigint := -1000000000000-txid_current()*3;
  b bigint := a-1; c bigint := a-2;
  product_id bigint; unavailable_id bigint; coupon_id bigint;
  request_id uuid := gen_random_uuid(); result jsonb; order_id bigint; second_id bigint;
  rejected boolean; n int;
begin
  begin
    insert into public.profiles(telegram_id,tg_phone,created_at) values
      (a,'+998900000000',now()-interval '100 days'),(b,'+998900000001',now()-interval '100 days'),(c,null,now());
    if (select count(distinct public_id) from public.profiles where telegram_id in(a,b,c))<>3 then raise exception 'Duplicate public ID'; end if;
    update public.settings set value='{"welcomePct":10,"welcomeDays":30,"inviterPct":33,"inviteeNextPct":11,"minQualifyingOrder":200000}' where key='promo';
    update public.settings set value='{"card":"Карта"}' where key='payments';
    update public.settings set value='["8600 0000 0000 0001"]' where key='payment_cards';

    perform public.ramp_apply_referral(b,(select public_id from public.profiles where telegram_id=a));
    result:=public.ramp_apply_referral(b,(select public_id from public.profiles where telegram_id=a));
    if (result->>'changed')::boolean then raise exception 'Referral applied twice'; end if;
    perform public.ramp_apply_referral(c,(select public_id from public.profiles where telegram_id=b));
    rejected:=false;
    begin perform public.ramp_apply_referral(a,(select public_id from public.profiles where telegram_id=c));
    exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Referral cycle accepted'; end if;

    insert into public.products(name,price,active,in_stock,options) values('QA Вариант',200000,true,true,
      '[{"name":"Размер","values":[{"label":"M","add":10000}]}]') returning id into product_id;
    insert into public.products(name,price,active,in_stock) values('QA Недоступный',10000,true,false) returning id into unavailable_id;
    insert into public.cart_items(telegram_id,product_id,qty,opts,variant) values
      (b,product_id,1,'{"Размер":"M"}','Размер: M'),(b,unavailable_id,1,'{}','');
    insert into public.coupons(telegram_id,pct,reason) values(b,15,'manual') returning id into coupon_id;
    result:=public.ramp_create_order(b,request_id,'{"full_name":"Тест Клиент","phone":"+998900000001","city":"Ташкент","address":"Тестовый адрес","payment_method":"card","total":1}');
    order_id:=(result->'order'->>'id')::bigint;
    if (result->'order'->>'subtotal')::int<>210000 or (result->'order'->>'total')::int<>178500 then raise exception 'Wrong variant price or discount'; end if;
    if (select used_order_id from public.coupons where id=coupon_id)<>order_id then raise exception 'Coupon not reserved'; end if;
    if not exists(select 1 from public.cart_items where telegram_id=b and cart_items.product_id=unavailable_id) then raise exception 'Unavailable item deleted'; end if;
    result:=public.ramp_create_order(b,request_id,'{}');
    if (result->>'created')::boolean or (result->'order'->>'id')::bigint<>order_id then raise exception 'Duplicate checkout'; end if;
    rejected:=false;
    begin perform public.ramp_set_order_status(order_id,'shipping'); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Unpaid order shipped'; end if;
    result:=public.ramp_set_order_status(order_id,'paid');
    if jsonb_array_length(result->'rewards')<>2 then raise exception 'Referral rewards not issued'; end if;
    perform public.ramp_set_order_status(order_id,'paid');
    select count(*) into n from public.coupons where source_order_id=order_id;
    if n<>2 then raise exception 'Duplicate referral rewards'; end if;
    perform public.ramp_set_order_status(order_id,'bought');
    perform public.ramp_set_order_status(order_id,'shipping');
    perform public.ramp_set_order_status(order_id,'arrived');
    perform public.ramp_set_order_status(order_id,'delivered');

    insert into public.cart_items(telegram_id,product_id,qty,opts,variant) values(b,product_id,1,'{"Размер":"M"}','Размер: M');
    result:=public.ramp_create_order(b,gen_random_uuid(),'{"full_name":"Тест Клиент","phone":"+998900000001","city":"Ташкент","address":"Тестовый адрес","payment_method":"card"}');
    second_id:=(result->'order'->>'id')::bigint;
    coupon_id:=(result->'order'->>'coupon_id')::bigint;
    perform public.ramp_set_order_status(second_id,'cancelled');
    if (select used_order_id from public.coupons where id=coupon_id) is not null then raise exception 'Coupon not returned'; end if;
    rejected:=false;
    begin perform public.ramp_set_order_status(second_id,'paid'); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Cancelled order reopened'; end if;

    rejected:=false;
    begin perform public.ramp_create_order(c,gen_random_uuid(),'{}'); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Phone registration bypassed'; end if;
    if public.ramp_claim_update('shop',a)<>'claimed' or public.ramp_claim_update('shop',a)<>'busy' then raise exception 'Webhook claim failed'; end if;
    update public.bot_updates set processed=true where bot_kind='shop' and update_id=a;
    if public.ramp_claim_update('shop',a)<>'done' or public.ramp_claim_update('admin',a)<>'claimed' then raise exception 'Webhook deduplication failed'; end if;
    if has_function_privilege('anon','public.ramp_create_order(bigint,uuid,jsonb)','execute') then raise exception 'Public checkout RPC access'; end if;
    if has_function_privilege('authenticated','public.ramp_admin_stats()','execute') then raise exception 'Public admin RPC access'; end if;
    raise exception using errcode='RT001',message='QA passed: rollback fixture';
  exception when sqlstate 'RT001' then null;
  end;
end $$;
select 'PASS: registration, unique IDs, referral cycles, prices, coupons, idempotency, order transitions, webhook deduplication, RPC grants' as result;
