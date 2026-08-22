-- ============================================================================
-- Mandate storefront — schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: everything is idempotent.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- products --
create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  price        integer not null,                       -- paise. ₹499 = 49900
  size         text,
  color        text,
  image_url    text,
  stock_count  integer not null default 0,
  status       text not null default 'available',      -- available | reserved | sold_out
  created_at   timestamptz default now(),
  constraint products_stock_non_negative check (stock_count >= 0),
  constraint products_price_positive     check (price > 0),
  constraint products_status_valid       check (status in ('available','reserved','sold_out'))
);

-- ------------------------------------------------------------------ orders --
create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid references public.products(id),
  customer_name       text,
  customer_email      text,
  amount              integer not null,                -- paise
  razorpay_order_id   text,
  razorpay_payment_id text,
  status              text not null default 'created', -- created|reserved|paid|failed|cancelled
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  constraint orders_status_valid check (status in ('created','reserved','paid','failed','cancelled'))
);

create index if not exists orders_status_created_idx    on public.orders (status, created_at);
create index if not exists orders_rzp_order_id_idx      on public.orders (razorpay_order_id);
create index if not exists products_status_idx          on public.products (status);

-- keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- Atomic stock operations.
--
-- These exist as SQL functions on purpose: the reservation MUST be a single
-- conditional UPDATE evaluated by Postgres, not a read-then-write round trip
-- from Node. Two concurrent buyers of the last unit both hit this statement;
-- Postgres serialises the row lock, the loser sees stock_count = 0, its WHERE
-- clause fails, and it returns zero rows. That is what produces the clean 409.
-- ============================================================================

-- Decrement one unit if (and only if) one is available. Returns the updated
-- row, or no rows at all when the item is out of stock.
create or replace function public.reserve_product_stock(p_product_id uuid)
returns setof public.products
language sql
as $$
  update public.products
     set stock_count = stock_count - 1,
         status = case when stock_count - 1 = 0 then 'sold_out' else status end
   where id = p_product_id
     and stock_count > 0
  returning *;
$$;

-- Give a reserved unit back (payment failed / abandoned / cancelled).
create or replace function public.release_product_stock(p_product_id uuid)
returns setof public.products
language sql
as $$
  update public.products
     set stock_count = stock_count + 1,
         status = 'available'
   where id = p_product_id
  returning *;
$$;

-- Sweep abandoned reservations. One statement per side, wrapped in a single
-- transaction by plpgsql, so an order can never be released twice.
create or replace function public.cancel_expired_orders(p_minutes integer default 10)
returns table (
  order_id   uuid,
  product_id uuid,
  amount     integer,
  created_at timestamptz
)
language plpgsql
as $$
declare
  expired_ids uuid[];
begin
  -- Claim the expired rows first. The status change is the lock: a concurrent
  -- run of this function will not see them as 'reserved' any more.
  with claimed as (
    update public.orders o
       set status = 'cancelled'
     where o.status = 'reserved'
       and o.created_at < now() - make_interval(mins => p_minutes)
    returning o.id
  )
  select array_agg(c.id) into expired_ids from claimed c;

  if expired_ids is null or array_length(expired_ids, 1) is null then
    return;
  end if;

  -- Return one unit of stock for each order we just claimed.
  update public.products p
     set stock_count = p.stock_count + sub.qty,
         status      = 'available'
    from (
      select o.product_id, count(*)::int as qty
        from public.orders o
       where o.id = any(expired_ids)
         and o.product_id is not null
       group by o.product_id
    ) sub
   where p.id = sub.product_id;

  return query
    select o.id, o.product_id, o.amount, o.created_at
      from public.orders o
     where o.id = any(expired_ids);
end;
$$;

-- ============================================================================
-- Row Level Security
--
-- The API routes talk to Postgres with the service-role key, which bypasses
-- RLS entirely. RLS is on anyway so that a leaked anon key cannot read orders
-- or write stock — the browser never queries these tables directly.
-- ============================================================================

alter table public.products enable row level security;
alter table public.orders   enable row level security;

drop policy if exists "products are publicly readable" on public.products;
create policy "products are publicly readable"
  on public.products for select
  to anon, authenticated
  using (true);

-- No anon policy on orders at all => anon can do nothing with orders.
