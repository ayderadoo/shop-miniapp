-- Real database checks with a rolled-back fixture; no Telegram messages are sent.
do $$
declare a bigint:=-4000000000000-txid_current()*3; b bigint:=a-1; c bigint:=a-2; adm bigint; token uuid; original_id text; r jsonb; sid bigint; upload_id uuid; path text; original_expiry timestamptz; denied boolean;
begin
 begin
  select telegram_id into adm from public.admins order by telegram_id limit 1;
  insert into public.profiles(telegram_id,tg_phone) values(a,'+998901234567'),(b,'+998901234568'),(c,'+998901234569');
  select referral_token,delivery_id into token,original_id from public.profiles where telegram_id=a;
  if token is null or token=(select referral_token from public.profiles where telegram_id=b) then raise exception 'Referral tokens not unique'; end if;
  r:=public.ramp_apply_referral_token(b,token);
  if not (r->>'changed')::boolean or (select referred_by from public.profiles where telegram_id=b)<>a then raise exception 'Referral link not applied'; end if;
  if (public.ramp_apply_referral_token(b,token)->>'changed')::boolean then raise exception 'Referral repeated'; end if;
  denied:=false;begin perform public.ramp_apply_referral_token(a,token); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Self referral accepted'; end if;
  denied:=false;begin perform public.ramp_apply_referral_token(a,(select referral_token from public.profiles where telegram_id=b)); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Referral cycle accepted'; end if;
  if (select delivery_id from public.profiles where telegram_id=a)<>original_id or (select delivery_id from public.client_identifiers where telegram_id=a)<>original_id then raise exception 'Personal ID changed'; end if;
  path:='news/qa-v4-'||gen_random_uuid()||'.jpg';
  insert into public.content_uploads(telegram_id,scope,path,mime,size) values(adm,'news',path,'image/jpeg',100) returning id into upload_id;
  insert into storage.objects(bucket_id,name,metadata) values('shop-content',path,'{"size":100,"mimetype":"image/jpeg"}');
  r:=public.ramp_save_story(adm,null,'QA история','Текст',true,24,jsonb_build_array(upload_id));sid:=(r->>'id')::bigint;
  original_expiry:=(r->>'expires_at')::timestamptz;
  if original_expiry<>now()+interval '24 hours' or (r->>'published_at')::timestamptz<>now() then raise exception '24 hour expiry missing'; end if;
  r:=public.ramp_save_story(adm,sid,'Правка подписи','Текст',true,24,jsonb_build_array(upload_id));
  if (r->>'expires_at')::timestamptz<>original_expiry then raise exception 'Editing reset lifetime'; end if;
  if not exists(select 1 from jsonb_array_elements(public.ramp_live_stories()) v where (v->>'id')::bigint=sid) then raise exception 'Live story missing'; end if;
  update public.shop_news set expires_at=now()-interval '1 second' where id=sid;
  if exists(select 1 from jsonb_array_elements(public.ramp_live_stories()) v where (v->>'id')::bigint=sid) then raise exception 'Expired story exposed'; end if;
  r:=public.ramp_save_story(adm,sid,'Повторная публикация','',true,24,jsonb_build_array(upload_id));
  if (r->>'expires_at')::timestamptz<=now() then raise exception 'Republish did not restart lifetime'; end if;
  r:=public.ramp_save_story(adm,sid,'Постоянная история','',true,null,jsonb_build_array(upload_id));
  if r->>'expires_at' is not null then raise exception 'Permanent story expires'; end if;
  perform public.ramp_save_story(adm,sid,'Скрытая история','',false,null,jsonb_build_array(upload_id));
  if exists(select 1 from jsonb_array_elements(public.ramp_live_stories()) v where (v->>'id')::bigint=sid) then raise exception 'Hidden story exposed'; end if;
  denied:=false;begin perform public.ramp_save_story(a,null,'Чужая','',true,24,jsonb_build_array(upload_id)); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Customer published story'; end if;
  denied:=false;begin perform public.ramp_save_story(adm,null,'Нет файла','',true,24,'[]'); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'New story without media accepted'; end if;
  denied:=false;begin perform public.ramp_save_story(adm,sid,'Неверный срок','',true,0,jsonb_build_array(upload_id)); exception when raise_exception then denied:=true; end;
  if not denied then raise exception 'Invalid lifetime accepted'; end if;
  if has_function_privilege('anon','public.ramp_apply_referral_token(bigint,uuid)','execute') or has_function_privilege('authenticated','public.ramp_live_stories(integer)','execute') or has_function_privilege('anon','public.ramp_save_story(bigint,bigint,text,text,boolean,integer,jsonb)','execute') then raise exception 'Unrestricted RPC'; end if;
  raise exception using errcode='RT004',message='QA rollback';
 exception when sqlstate 'RT004' then null;
 end;
end $$;
select 'PASS: opaque referral links, self/cycle protection, stable order IDs, story publication/expiry/edit/permanent/republish/hide, media/admin checks and grants' as result;
