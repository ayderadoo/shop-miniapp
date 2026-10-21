-- Тестовые записи откатываются; реальные новости, отзывы, номера и товары не меняются.
do $$
declare
  a bigint:=-2000000000000-txid_current()*3; b bigint:=a-1; c bigint:=a-2;
  admin_id bigint; product bigint; order_id bigint; upload_id uuid; upload_path text;
  first_id text; delivery text; result jsonb; review_id bigint; rejected boolean;
begin
  begin
    select telegram_id into admin_id from public.admins order by telegram_id limit 1;
    insert into public.profiles(telegram_id,tg_phone) values(a,'+998901234567'),(b,'+79991234567'),(c,'+998911234567');
    select public_id,delivery_id into first_id,delivery from public.profiles where telegram_id=a;
    if delivery is null or (select delivery_id from public.client_identifiers where telegram_id=a)<>delivery then raise exception 'Delivery ID not registered'; end if;
    rejected:=false;
    begin update public.profiles set delivery_id='RAMP-D0' where telegram_id=a; exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Delivery ID changed'; end if;
    update public.profiles set first_name='Покупатель QA' where telegram_id=a;
    if (select public_id from public.profiles where telegram_id=a)<>first_id then raise exception 'Profile ID changed'; end if;

    insert into public.products(name,sku,price,active,in_stock) values('QA Артикул','QA-'||txid_current(),250000,true,true) returning id into product;
    rejected:=false;
    begin insert into public.products(name,sku,price) values('QA Дубль','qa-'||txid_current(),1); exception when unique_violation then rejected:=true; end;
    if not rejected then raise exception 'Duplicate SKU accepted'; end if;
    insert into public.cart_items(telegram_id,product_id,qty) values(a,product,2),(b,product,1);
    update public.settings set value='{"card":"Карта"}' where key='payments';
    update public.settings set value='["8600 0000 0000 0001"]' where key='payment_cards';
    rejected:=false;
    begin perform public.ramp_create_order(b,gen_random_uuid(),'{"full_name":"Тест Клиент","phone":"+998901234567","city":"Ташкент","address":"Улица Тестовая","payment_method":"card"}');
    exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Foreign phone accepted'; end if;
    result:=public.ramp_create_order(a,gen_random_uuid(),'{"full_name":"Тест Клиент","phone":"+998901234567","city":"Ташкент","address":"Улица Тестовая","payment_method":"card"}');
    order_id:=(result->'order'->>'id')::bigint;
    if result->'order'->>'delivery_id'<>delivery or result->'order'->'items'->0->>'sku'<>'QA-'||txid_current() then raise exception 'SKU or delivery snapshot missing'; end if;
    update public.products set sku='QA-NEW-'||txid_current() where id=product;
    if (select items->0->>'sku' from public.orders where id=order_id)<>'QA-'||txid_current() then raise exception 'Historical SKU changed'; end if;
    if (select qty from public.order_procurement where id=order_id)<>2 then raise exception 'Procurement export failed'; end if;

    rejected:=false;
    begin perform public.ramp_save_review(b,null,product,'customer','Fake',5,'Отзыв',true,'[]'); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Foreign phone review accepted'; end if;
    result:=public.ramp_save_review(a,null,product,'customer','Fake name',5,'Товар понравился',true,'[]');
    review_id:=(result->>'id')::bigint;
    if result->>'status'<>'pending' or result->>'author_name'='Fake name' then raise exception 'Review moderation or identity bypass'; end if;
    perform public.ramp_save_review(a,review_id,product,'customer','Fake',4,'Изменённый отзыв',true,'[]');
    if (select count(*) from public.product_reviews where telegram_id=a)<>1 then raise exception 'Review duplicate'; end if;
    upload_path:='review/qa-'||gen_random_uuid()||'.jpg';
    insert into public.content_uploads(telegram_id,scope,path,mime,size) values(a,'review',upload_path,'image/jpeg',100) returning id into upload_id;
    rejected:=false;
    begin perform public.ramp_save_review(a,review_id,product,'customer','',5,'С фото',false,jsonb_build_array(upload_id)); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Missing upload accepted'; end if;
    insert into storage.objects(bucket_id,name,metadata) values('shop-content',upload_path,'{"size":100,"mimetype":"image/jpeg"}');
    result:=public.ramp_save_review(a,review_id,product,'customer','',5,'С фото',false,jsonb_build_array(upload_id));
    if jsonb_array_length(result->'media')<>1 then raise exception 'Review media missing'; end if;
    rejected:=false;
    begin perform public.ramp_save_review(c,null,product,'customer','',5,'Чужое фото',false,jsonb_build_array(upload_id)); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Another customer media accepted'; end if;
    result:=public.ramp_save_news(admin_id,null,'QA Новость','Текст новости',false,true,-10,'[]');
    if (result->>'published')::boolean then raise exception 'Draft published'; end if;
    perform public.ramp_save_news(admin_id,(result->>'id')::bigint,'QA Новость','Текст новости',true,true,-10,'[]');
    rejected:=false;
    begin perform public.ramp_save_news(a,null,'Чужая новость','Текст',true,true,0,'[]'); exception when raise_exception then rejected:=true; end;
    if not rejected then raise exception 'Customer published news'; end if;
    result:=public.ramp_save_review(admin_id,null,null,'store','Автор видео',5,'Видеоотзыв магазина',true,'[]');
    if result->>'source'<>'store' or result->>'status'<>'approved' or (result->>'verified_purchase')::boolean then raise exception 'Store review mislabeled'; end if;
    if has_table_privilege('anon','public.product_reviews','select') or has_table_privilege('authenticated','public.client_identifiers','select') then raise exception 'Private data exposed'; end if;
    if has_function_privilege('anon','public.ramp_save_review(bigint,bigint,bigint,text,text,integer,text,boolean,jsonb)','execute') then raise exception 'Public content write RPC'; end if;
    raise exception using errcode='RT002',message='QA passed: rollback fixture';
  exception when sqlstate 'RT002' then null;
  end;
end $$;
select 'PASS: ID registry, immutable delivery IDs, SKU uniqueness and snapshots, UZ-only registration, reviews, moderation, news, upload ownership and grants' as result;
