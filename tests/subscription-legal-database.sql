-- Every fixture rolls back, including when run under service_role.
do $$
declare a bigint:=-3000000000000-txid_current(); adm bigint; p bigint; r jsonb; row_id bigint; denied boolean;
begin
 begin
  select telegram_id into adm from public.admins order by telegram_id limit 1;
  insert into public.profiles(telegram_id,tg_phone) values(a,'+998901234567');
  if (select subscription_verified_at from public.profiles where telegram_id=a) is not null then raise exception 'New profile already subscribed'; end if;
  insert into public.products(name,sku,price) values('QA V3','QA-V3-'||txid_current(),1000) returning id into p;
  r:=public.ramp_save_store_review(adm,null,p,'Автор',5,'Отзыв с площадки',true,'[]','Pinduoduo','https://example.com/item');
  row_id:=(r->>'id')::bigint;
  if r->>'origin_name'<>'Pinduoduo' or r->>'status'<>'approved' or (r->>'verified_purchase')::boolean then raise exception 'Attribution/publication incorrect'; end if;
  denied:=false;
  begin perform public.ramp_save_store_review(a,null,p,'Fake',5,'Чужая публикация',true,'[]','Source',null); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Non-admin store publication'; end if;
  denied:=false;
  begin perform public.ramp_save_store_review(adm,row_id,p,'Автор',5,'Текст',true,'[]','Source','javascript:alert(1)'); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Invalid source URL'; end if;
  insert into public.product_reviews(telegram_id,product_id,author_name,rating,body,source,status,media) values
    (a,p,'Автор RAMP',4,'С фото','customer','approved','[{"mime":"image/jpeg","path":"qa/test.jpg"}]'),
    (adm,p,'Видео магазина',3,'С видео','store','approved','[{"mime":"video/mp4","path":"qa/test.mp4"}]'),
    (adm,p,'Черновик',1,'Не опубликован','store','pending','[]');
  r:=public.ramp_review_feed(p,null,'all','all',0);
  if jsonb_array_length(r->'reviews')<>3 or (r->'stats'->>'count')::int<>3 or (r->'stats'->>'rating')::numeric<>4 then raise exception 'Feed/stats leak draft or wrong average'; end if;
  if (r->'stats'->'distribution'->>'1')::int<>0 or (r->'stats'->'distribution'->>'5')::int<>1 then raise exception 'Wrong histogram'; end if;
  if jsonb_array_length(public.ramp_review_feed(p,4,'photo','customer',0)->'reviews')<>1 then raise exception 'Combined customer/photo/rating filters fail'; end if;
  if jsonb_array_length(public.ramp_review_feed(p,null,'video','store',0)->'reviews')<>1 then raise exception 'Video/store filter fails'; end if;
  if jsonb_array_length(public.ramp_review_feed(p,null,'all','marketplace',0)->'reviews')<>1 then raise exception 'Marketplace source filter fails'; end if;
  if jsonb_array_length(public.ramp_review_feed(p,1,'all','all',0)->'reviews')<>0 then raise exception 'Pending review exposed'; end if;
  denied:=false;
  begin perform public.ramp_review_feed(p,6,'all','all',0); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Invalid rating accepted'; end if;
  insert into public.product_reviews(telegram_id,product_id,author_name,rating,body,source,status) select adm,p,'Pagination QA',5,'Текст','store','approved' from generate_series(1,22);
  if jsonb_array_length(public.ramp_review_feed(p,null,'all','all',0)->'reviews')<>21 or jsonb_array_length(public.ramp_review_feed(p,null,'all','all',20)->'reviews')<>5 then raise exception 'Pagination failed'; end if;
  if has_table_privilege('anon','public.shop_documents','select') or has_table_privilege('authenticated','public.shop_documents','update') then raise exception 'Private document drafts exposed'; end if;
  if has_function_privilege('anon','public.ramp_review_feed(bigint,integer,text,text,integer)','execute') or has_function_privilege('authenticated','public.ramp_save_store_review(bigint,bigint,bigint,text,integer,text,boolean,jsonb,text,text)','execute') then raise exception 'Unrestricted feed/write RPC'; end if;
  if (select count(*) from public.shop_documents where slug in ('offer','privacy'))<>2 then raise exception 'Missing documents'; end if;
  raise exception using errcode='RT003',message='QA passed: rollback fixtures';
 exception when sqlstate 'RT003' then null;
 end;
end $$;
select 'PASS: V3 feed, distribution, photo/video/rating/source filters, pagination, source validation, admin authorization, private documents and rollback' as result;
