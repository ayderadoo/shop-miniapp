-- Separate opaque invitation links; existing personal/order IDs and old links stay valid.
alter table public.profiles add column referral_token uuid not null default gen_random_uuid();
create unique index profiles_referral_token_unique on public.profiles(referral_token);
create function public.ramp_apply_referral_token(p_uid bigint,p_token uuid) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare legacy_code text;
begin
  select public_id into legacy_code from public.profiles where referral_token=p_token;
  if legacy_code is null then raise exception 'Ссылка приглашения не найдена'; end if;
  return public.ramp_apply_referral(p_uid,legacy_code);
end $$;
revoke all on function public.ramp_apply_referral_token(bigint,uuid) from public,anon,authenticated;
grant execute on function public.ramp_apply_referral_token(bigint,uuid) to service_role;

-- Existing news remain available without an expiry. New stories default to 24 hours.
alter table public.shop_news add column duration_hours integer check(duration_hours between 1 and 720),
  add column published_at timestamptz,
  add column expires_at timestamptz;
update public.shop_news set published_at=created_at where published;
alter table public.shop_news alter column duration_hours set default 24;
create index stories_expiry_idx on public.shop_news(expires_at) where published and expires_at is not null;

create function public.ramp_save_story(p_uid bigint,p_id bigint,p_title text,p_body text,p_published boolean,p_duration_hours integer,p_media jsonb) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare previous public.shop_news; result jsonb; start_at timestamptz; finish_at timestamptz;
begin
  if not exists(select 1 from public.admins where telegram_id=p_uid) then raise exception 'Нет доступа'; end if;
  if p_duration_hours is not null and p_duration_hours not between 1 and 720 then raise exception 'Срок истории — от 1 часа до 30 дней'; end if;
  if jsonb_typeof(p_media) is distinct from 'array' or jsonb_array_length(p_media)>5 then raise exception 'Добавьте до пяти фото или видео'; end if;
  if p_id is null and jsonb_array_length(p_media)=0 then raise exception 'Добавьте фото или видео для истории'; end if;
  if p_id is not null then
    select * into previous from public.shop_news where id=p_id for update;
    if not found then raise exception 'История не найдена'; end if;
  end if;
  result:=public.ramp_save_news(p_uid,p_id,coalesce(nullif(trim(p_title),''),'История RAMP'),p_body,p_published,false,0,p_media);
  start_at:=previous.published_at; finish_at:=previous.expires_at;
  if p_published and (previous.id is null or not previous.published or previous.expires_at<=now() or previous.duration_hours is distinct from p_duration_hours or start_at is null) then
    start_at:=now(); finish_at:=case when p_duration_hours is null then null else now()+p_duration_hours*interval '1 hour' end;
  elsif p_duration_hours is null then finish_at:=null;
  end if;
  update public.shop_news set duration_hours=p_duration_hours,published_at=start_at,expires_at=finish_at
    where id=(result->>'id')::bigint returning to_jsonb(shop_news.*) into result;
  return result;
end $$;
create function public.ramp_live_stories(p_offset integer default 0) returns jsonb
language sql stable set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (
    select id,title,body,media,published_at,expires_at,created_at,updated_at from public.shop_news
    where published and (expires_at is null or expires_at>now())
    order by pinned desc,position,created_at desc,id desc limit 21 offset greatest(0,least(p_offset,1000000))
  ) t;
$$;
revoke all on function public.ramp_save_story(bigint,bigint,text,text,boolean,integer,jsonb),public.ramp_live_stories(integer) from public,anon,authenticated;
grant execute on function public.ramp_save_story(bigint,bigint,text,text,boolean,integer,jsonb),public.ramp_live_stories(integer) to service_role;
