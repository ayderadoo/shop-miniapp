insert into public.settings(key,value,updated_at) values
  ('payments','{"card":"Перевод на карту"}'::jsonb, now()),
  ('payment_cards','["8600 0000 0000 0000"]'::jsonb, now())
on conflict (key) do update set value=excluded.value, updated_at=now();
