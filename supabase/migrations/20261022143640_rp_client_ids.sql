-- Личные ID клиентов RP-1, RP-2… без пропусков; номер клиента (user_no) = число в ID.
-- Последовательность (identity) теряет номера при откатах, поэтому номер выдаёт счётчик в таблице:
-- его изменение откатывается вместе с неудачной регистрацией. Значение identity триггер заменяет.
create table public.client_counter (
  id boolean primary key default true check (id),
  last_no bigint not null check (last_no >= 0)
);
alter table public.client_counter enable row level security;
revoke all on public.client_counter from public, anon, authenticated;
grant select, update on public.client_counter to service_role;

-- Перенумерация по дате регистрации: через отрицательные значения, чтобы не задеть уникальные индексы.
alter table public.profiles disable trigger profiles_delivery_id;
update public.profiles p set user_no = -o.n
  from (select telegram_id, row_number() over (order by created_at, user_no) n from public.profiles) o
  where o.telegram_id = p.telegram_id;
update public.profiles set user_no = -user_no, delivery_id = 'RP-' || (-user_no) where user_no < 0;
alter table public.profiles enable trigger profiles_delivery_id;
alter table public.profiles add constraint profiles_delivery_id_rp check (delivery_id = 'RP-' || user_no);

-- Реестр выданных ID: прежний номер сохраняется в legacy_delivery_id. Копии в заказах обновляются.
alter table public.client_identifiers add column legacy_delivery_id text;
update public.client_identifiers c set legacy_delivery_id = c.delivery_id, delivery_id = p.delivery_id
  from public.profiles p where p.telegram_id = c.telegram_id and c.delivery_id is distinct from p.delivery_id;
update public.orders o set delivery_id = p.delivery_id
  from public.profiles p where p.telegram_id = o.telegram_id and o.delivery_id is distinct from p.delivery_id;

insert into public.client_counter(id, last_no) select true, coalesce(max(user_no), 0) from public.profiles;

create or replace function public.ramp_assign_delivery_id() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' then
    if new.public_id is distinct from old.public_id or new.delivery_id is distinct from old.delivery_id or new.user_no is distinct from old.user_no then
      raise exception 'Выданный ID клиента нельзя менять';
    end if;
  else
    update public.client_counter set last_no = last_no + 1 where id returning last_no into new.user_no;
    if new.user_no is null then raise exception 'Счётчик клиентов не настроен'; end if;
    new.delivery_id := 'RP-' || new.user_no;
  end if;
  return new;
end $$;
revoke all on function public.ramp_assign_delivery_id() from public, anon, authenticated;
