alter table public.profiles add column subscription_verified_at timestamptz,
  add column subscription_channel text;
alter table public.product_reviews add column origin_name text check(length(origin_name) between 1 and 80),
  add column origin_url text check(length(origin_url)<=1000 and origin_url ~ '^https://[^[:space:]]+$'),
  add constraint review_origin_store_only check((origin_name is null and origin_url is null) or (source='store' and origin_name is not null));
create index reviews_approved_rating_idx on public.product_reviews(rating,created_at desc,id desc) where status='approved';

-- Separate wrapper keeps attribution, attachment ownership and publication in one transaction.
create function public.ramp_save_store_review(p_uid bigint,p_id bigint,p_product_id bigint,p_author text,p_rating integer,p_body text,p_publish boolean,p_media jsonb,p_origin_name text,p_origin_url text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare item jsonb; origin text:=nullif(trim(p_origin_name),''); link text:=nullif(trim(p_origin_url),'');
begin
  if length(origin)>80 or length(link)>1000 or (link is not null and (origin is null or link !~ '^https://[^[:space:]]+$')) then raise exception 'Укажите источник и корректную HTTPS-ссылку'; end if;
  item:=public.ramp_save_review(p_uid,p_id,p_product_id,'store',p_author,p_rating,p_body,false,p_media);
  update public.product_reviews set origin_name=origin,origin_url=link,status=case when p_publish then 'approved' else 'pending' end
    where id=(item->>'id')::bigint returning to_jsonb(product_reviews.*) into item;
  return item;
end $$;
revoke all on function public.ramp_save_store_review(bigint,bigint,bigint,text,integer,text,boolean,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.ramp_save_store_review(bigint,bigint,bigint,text,integer,text,boolean,jsonb,text,text) to service_role;

create function public.ramp_review_feed(p_product_id bigint default null,p_rating integer default null,p_media text default 'all',p_source text default 'all',p_offset integer default 0) returns jsonb
language plpgsql stable set search_path=public,pg_temp as $$
declare result jsonb; stats jsonb;
begin
  if (p_rating is not null and p_rating not between 1 and 5) or p_media not in ('all','photo','video') or p_source not in ('all','customer','store','marketplace') or p_offset not between 0 and 1000000 then raise exception 'Неверный фильтр отзывов'; end if;
  with base as (
    select r.* from public.product_reviews r where r.status='approved' and (p_product_id is null or r.product_id=p_product_id)
      and (p_source='all' or (p_source='customer' and r.source='customer') or (p_source='store' and r.source='store' and r.origin_name is null) or (p_source='marketplace' and r.source='store' and r.origin_name is not null))
  ) select jsonb_build_object('count',count(*),'rating',coalesce(round(avg(rating),1),0),
    'distribution',jsonb_build_object('5',count(*) filter(where rating=5),'4',count(*) filter(where rating=4),'3',count(*) filter(where rating=3),'2',count(*) filter(where rating=2),'1',count(*) filter(where rating=1))) into stats from base;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into result from (
    select r.id,r.product_id,r.author_name,r.rating,r.body,r.source,r.origin_name,r.origin_url,r.media,r.verified_purchase,r.created_at,
      case when p.id is not null then jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku) else null end as product
    from public.product_reviews r left join public.products p on p.id=r.product_id
    where r.status='approved' and (p_product_id is null or r.product_id=p_product_id) and (p_rating is null or r.rating=p_rating)
      and (p_source='all' or (p_source='customer' and r.source='customer') or (p_source='store' and r.source='store' and r.origin_name is null) or (p_source='marketplace' and r.source='store' and r.origin_name is not null))
      and (p_media='all' or exists(select 1 from jsonb_array_elements(r.media) m where m->>'mime' like case p_media when 'photo' then 'image/%' else 'video/%' end))
    order by r.created_at desc,r.id desc offset p_offset limit 21
  ) t;
  return jsonb_build_object('reviews',result,'stats',stats);
end $$;
revoke all on function public.ramp_review_feed(bigint,integer,text,text,integer) from public,anon,authenticated;
grant execute on function public.ramp_review_feed(bigint,integer,text,text,integer) to service_role;

create table public.shop_documents (
  slug text primary key check(slug in ('privacy','offer')),
  title text not null check(length(title) between 1 and 160),
  body text not null check(length(body) between 10 and 20000),
  published boolean not null default false,
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now(),
  updated_by bigint
);
alter table public.shop_documents enable row level security;
revoke all on public.shop_documents from public,anon,authenticated;
grant select,insert,update on public.shop_documents to service_role;

insert into public.shop_documents(slug,title,body) values
('privacy','Политика конфиденциальности',$privacy$1. Кто обрабатывает данные
ООО «RAMP» использует данные покупателей для работы магазина RAMP в Telegram. Контакт по вопросам данных и поддержки: @ramphelper.
Адрес для обращений: {{почтовый адрес ООО «RAMP»}}. Электронная почта: {{email}}. Телефон: {{контактный телефон}}.

2. Какие данные используются
Telegram ID, имя и username, собственный номер Telegram +998, результат проверки подписки на @ramp_uz, ID клиента и доставок, данные получателя и адрес, состав и история заказов, скидки и приглашения. Если вы отправляете заявку, отзыв или чек, сохраняются их текст и вложения. Содержание чека доступно администраторам, поэтому не присылайте CVV, пароли и коды подтверждения.

3. Для чего нужны данные
Для регистрации, оформления и доставки заказов, сверки оплаты, поддержки, расчёта скидок и модерации отзывов. Собственный номер подтверждается только через кнопку Telegram, подписка проверяется через Telegram Bot API.

4. Доступ и передача
К данным обращаются уполномоченные администраторы. Необходимые сведения о получателе и заказе передаются исполнителям доставки и выкупа. Приложение использует Telegram, Supabase для серверной обработки, базы и файлов и хостинг страниц. Текущий регион базы Supabase — eu-west-1 (Ирландия); данные не следует считать хранящимися только в Узбекистане. Условия и основание обработки вне Узбекистана должны быть определены оператором до публикации этой редакции.

5. Публичные отзывы
После проверки публикуются имя автора, оценка, текст и выбранные фото/видео. Телефон, адрес и Telegram ID в публичный отзыв не включаются. Не прикрепляйте к отзыву свои или чужие документы и другие личные сведения. Отзывы, перенесённые магазином с другой площадки, имеют отдельную отметку источника.

6. Хранение и обращения
Данные хранятся для исполнения заказов, поддержки и выполнения применимых обязанностей. Для запроса доступа, исправления или удаления напишите @ramphelper. Данные, которые необходимо сохранять по закону или для незавершённого заказа, могут быть сохранены на необходимый срок. Автоматического удаления аккаунта в интерфейсе сейчас нет.

7. Устройства и изменения
На устройстве сохраняются настройки вида каталога и способа оплаты. Актуальная опубликованная редакция доступна в профиле и перед регистрацией; дата и версия указаны на странице.$privacy$),
('offer','Публичная оферта',$offer$1. Исполнитель и контакты
ООО «RAMP» (далее — RAMP) предлагает оформление заказа, выкуп и организацию доставки товаров через мини-приложение @ramp_uzbot. Поддержка: @ramphelper.
ИНН: {{ИНН ООО «RAMP»}}. Почтовый адрес: {{почтовый адрес}}. Электронная почта: {{email}}. Телефон: {{контактный телефон}}.

2. Заказ и условия
Покупатель выбирает товар и его параметры, указывает достоверные данные получателя и отправляет заказ. Товар определяется названием, артикулом, выбранными параметрами и количеством в подтверждённом заказе. До оплаты покупатель должен получить итоговую стоимость, состав услуг, условия и ожидаемый срок доставки. Дополнительные расходы согласуются заранее; несогласованные платежи не включаются автоматически.

3. Оплата
Расчёты ведутся в сумах. После оформления в приложении показываются реквизиты. Заказ принимается в работу после полной предоплаты и подтверждения фактического поступления средств. Отправленный чек сам по себе не является подтверждением поступления. Изменение цены и замена товара после согласования возможны только с согласия покупателя; если исполнение невозможно, стороны согласуют замену либо возврат.

4. Выкуп и доставка
Ожидаемые сроки и способ передачи согласуются до оплаты. Статусы выкупа и доставки, ID клиента и доступный трек-номер отображаются в заказах. Если доставка оплачивается отдельно, её стоимость и условия сообщаются до оплаты. Покупатель проверяет контактные данные и сообщает об ошибках в поддержку.

5. Отмена, недостатки и возврат
До выкупа можно обратиться в поддержку с запросом отмены и возврата. После выкупа условия определяются характером заказа и применимым законодательством. При неверной комплектации, повреждении или недостатках свяжитесь с @ramphelper, укажите номер заказа и приложите материалы для проверки. Срок, сумма и порядок возврата сообщаются по результатам обращения в пределах применимых требований закона. Эти условия не отменяют обязательные права потребителя.

6. Скидки и приглашения
Актуальные скидки и купоны показаны в профиле; применяется наибольшая доступная скидка. Условия приглашений доступны в разделе «Пригласить друга». Скидки и купоны не являются денежным балансом. Бонусные баллы из сторонних магазинов в RAMP не используются.

7. Отзывы и информация
Покупатель может отправить отзыв с оценкой и фото/видео; отзывы проходят модерацию. Материалы с маркетплейсов помечаются источником и не означают подтверждённую покупку в RAMP. Изображения и отзывы используются с соблюдением прав их владельцев.

8. Данные и обращения
Порядок использования данных описан в политике конфиденциальности. По вопросам заказа, претензиям и данным обращайтесь @ramphelper. Актуальная редакция, её версия и дата доступны в профиле. Изменения не меняют уже согласованные условия оплаченного заказа без предусмотренного законом основания.$offer$);
