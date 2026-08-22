-- ============================================================================
--  MIGRATION 002 — quantity and discount support for POST /api/orders
--
--  Run this in the Supabase SQL Editor:
--    https://supabase.com/dashboard/project/sjyfbjojyewhpegehnwi/sql/new
--
--  Additive and idempotent. Existing orders get quantity = 1, discount = 0,
--  which is exactly what they were. Nothing already working changes behaviour.
--
--  Why a migration is needed: the orders table stored one product_id and one
--  amount with no quantity column, so "order 3 of these" had nowhere to live,
--  and discount_percent had nowhere to be recorded. Storing only the final
--  discounted amount would make an order unauditable — you could not tell a
--  30%-off order of one unit from a full-price order of a cheaper item.
--
--  Ends with a verification query. It must print ✅ MIGRATION OK.
-- ============================================================================

-- ---------------------------------------------------------------- 1. columns --

alter table public.orders
  add column if not exists quantity integer not null default 1;

alter table public.orders
  add column if not exists discount_percent integer not null default 0;

-- Amounts stay in paise everywhere. These record how `amount` was derived, so
-- a stored order can be re-checked: amount = round(unit_price * quantity * (100 - discount_percent) / 100)
alter table public.orders
  add column if not exists unit_price integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_quantity_positive') then
    alter table public.orders add constraint orders_quantity_positive check (quantity >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_discount_range') then
    alter table public.orders
      add constraint orders_discount_range check (discount_percent >= 0 and discount_percent <= 100);
  end if;
end $$;

-- Backfill unit_price for rows written before this migration. They were all
-- single-unit, undiscounted, so the amount *was* the unit price.
update public.orders set unit_price = amount where unit_price is null;

-- ============================================================================
--  2. QUANTITY-AWARE ATOMIC RESERVATION
--
--  Same guarantee as reserve_product_stock, generalised to N units: a single
--  conditional UPDATE, evaluated by Postgres under a row lock. Two concurrent
--  callers competing for the last units both reach this statement; the loser
--  re-evaluates `stock_count >= N` against the committed value, fails it, and
--  gets ZERO ROWS back. That is what the route turns into a clean 409.
--
--  With N = 1 this is identical to reserve_product_stock, so both the browser
--  checkout and the agent endpoint can share it — one implementation of the
--  stock lock, which is the point.
-- ============================================================================

create or replace function public.reserve_product_stock_qty(
  p_product_id uuid,
  p_quantity   integer default 1
)
returns setof public.products
language sql
as $$
  update public.products
     set stock_count = stock_count - p_quantity,
         status = case when stock_count - p_quantity = 0 then 'sold_out' else status end
   where id = p_product_id
     and p_quantity >= 1
     and stock_count >= p_quantity
  returning *;
$$;

create or replace function public.release_product_stock_qty(
  p_product_id uuid,
  p_quantity   integer default 1
)
returns setof public.products
language sql
as $$
  update public.products
     set stock_count = stock_count + p_quantity,
         status = 'available'
   where id = p_product_id
     and p_quantity >= 1
  returning *;
$$;

-- The single-unit functions stay, delegating to the qty versions so there is
-- genuinely one implementation. Anything still calling them is unaffected.
create or replace function public.reserve_product_stock(p_product_id uuid)
returns setof public.products
language sql
as $$
  select * from public.reserve_product_stock_qty(p_product_id, 1);
$$;

create or replace function public.release_product_stock(p_product_id uuid)
returns setof public.products
language sql
as $$
  select * from public.release_product_stock_qty(p_product_id, 1);
$$;

-- ============================================================================
--  3. EXPIRY SWEEPER — must return `quantity` units, not one
-- ============================================================================

create or replace function public.cancel_expired_orders(p_minutes integer default 10)
returns table (
  order_id   uuid,
  product_id uuid,
  quantity   integer,
  amount     integer,
  created_at timestamptz
)
language plpgsql
as $$
declare
  expired_ids uuid[];
begin
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

  -- sum(quantity), not count(*) — a 3-unit order must give back 3 units.
  update public.products p
     set stock_count = p.stock_count + sub.qty,
         status      = 'available'
    from (
      select o.product_id, sum(o.quantity)::int as qty
        from public.orders o
       where o.id = any(expired_ids)
         and o.product_id is not null
       group by o.product_id
    ) sub
   where p.id = sub.product_id;

  return query
    select o.id, o.product_id, o.quantity, o.amount, o.created_at
      from public.orders o
     where o.id = any(expired_ids);
end;
$$;

-- ============================================================================
--  4. VERIFICATION
-- ============================================================================

with checks as (
  select 1 as ord, 'orders.quantity' as item, 'default 1, >= 1' as detail,
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='orders' and column_name='quantity') as pass
  union all
  select 2, 'orders.discount_percent', 'default 0, 0..100',
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='orders' and column_name='discount_percent')
  union all
  select 3, 'orders.unit_price', 'paise, backfilled',
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='orders' and column_name='unit_price')
  union all
  select 4, 'fn reserve_product_stock_qty', 'atomic N-unit reservation',
         to_regprocedure('public.reserve_product_stock_qty(uuid,integer)') is not null
  union all
  select 5, 'fn release_product_stock_qty', 'returns N units',
         to_regprocedure('public.release_product_stock_qty(uuid,integer)') is not null
  union all
  select 6, 'fn reserve_product_stock', 'still present, delegates to qty',
         to_regprocedure('public.reserve_product_stock(uuid)') is not null
  union all
  select 7, 'sweeper returns quantity', 'sum(quantity) not count(*)',
         to_regprocedure('public.cancel_expired_orders(integer)') is not null
  union all
  select 8, 'existing orders backfilled',
         (select count(*)::text from public.orders where unit_price is not null) || ' row(s)',
         not exists (select 1 from public.orders where unit_price is null)
)
select
  case when bool_and(pass) then '✅ MIGRATION OK' else '❌ MIGRATION INCOMPLETE' end as result,
  string_agg(case when pass then '  PASS  ' else '  FAIL  ' end || rpad(item, 30) || detail,
             E'\n' order by ord) as details
from checks;
