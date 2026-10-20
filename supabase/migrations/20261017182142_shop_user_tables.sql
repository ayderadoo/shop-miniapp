alter table public.products add column if not exists in_stock boolean not null default true;

create table if not exists public.profiles (
  telegram_id bigint primary key,
  first_name text,
  last_name text,
  username text,
  full_name text,
  phone text,
  city text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cart_items (
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  qty integer not null check (qty > 0 and qty <= 99),
  created_at timestamptz not null default now(),
  primary key (telegram_id, product_id)
);

create table if not exists public.wishlist (
  telegram_id bigint not null references public.profiles(telegram_id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (telegram_id, product_id)
);

create table if not exists public.orders (
  id bigint generated always as identity primary key,
  telegram_id bigint not null references public.profiles(telegram_id),
  items jsonb not null,
  total integer not null,
  status text not null default 'new'
    check (status in ('new','paid','bought','shipping','arrived','delivered','cancelled')),
  full_name text,
  phone text,
  address text,
  comment text,
  admin_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.photo_requests (
  id bigint generated always as identity primary key,
  telegram_id bigint not null references public.profiles(telegram_id),
  photo_path text not null,
  comment text,
  status text not null default 'new' check (status in ('new','answered')),
  answer text,
  admin_message_id bigint,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists orders_telegram_id_idx on public.orders(telegram_id);
create index if not exists orders_admin_msg_idx on public.orders(admin_message_id);
create index if not exists photo_requests_telegram_id_idx on public.photo_requests(telegram_id);
create index if not exists photo_requests_admin_msg_idx on public.photo_requests(admin_message_id);

-- Доступ к этим таблицам только через серверную функцию (service role).
alter table public.profiles enable row level security;
alter table public.cart_items enable row level security;
alter table public.wishlist enable row level security;
alter table public.orders enable row level security;
alter table public.photo_requests enable row level security;

-- Приватное хранилище для фото из заявок
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('requests', 'requests', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
