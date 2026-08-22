-- ============================================================================
--  MANDATE STOREFRONT — COMPLETE DATABASE SETUP
--  ---------------------------------------------------------------------------
--  Run this ONE file in the Supabase SQL Editor. Select all, paste, press Run.
--
--    https://supabase.com/dashboard/project/sjyfbjojyewhpegehnwi/sql/new
--
--  It creates the tables, constraints, indexes, the atomic stock functions,
--  Row Level Security, and seeds 15 products.
--
--  Safe to re-run. Re-running RESETS the catalogue and DELETES all orders.
--  The last statement prints a verification summary — check it says
--  "SETUP OK" before you close the tab.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
--  1. TABLES
-- ============================================================================

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
  status       text not null default 'available',      -- available|reserved|sold_out
  created_at   timestamptz default now(),

  -- The belt to the reservation logic's braces. Even a future bug cannot push
  -- stock negative — the transaction aborts instead of overselling.
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

-- ============================================================================
--  2. INDEXES
-- ============================================================================

-- The expiry sweeper scans exactly this: reserved orders older than N minutes.
create index if not exists orders_status_created_idx on public.orders (status, created_at);

-- The Razorpay webhook looks orders up by their gateway id.
create index if not exists orders_rzp_order_id_idx   on public.orders (razorpay_order_id);

create index if not exists products_status_idx       on public.products (status);

-- ============================================================================
--  3. TRIGGERS
-- ============================================================================

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
--  4. ATOMIC STOCK OPERATIONS
--
--  These live in SQL on purpose. The reservation MUST be a single conditional
--  UPDATE evaluated by Postgres, not a read-then-write round trip from Node.
--
--  Two concurrent buyers of the last unit both reach this statement. Postgres
--  takes a row lock: the first decrements 1 -> 0 and gets a row back. The
--  second then re-evaluates its WHERE clause against the committed value,
--  finds stock_count > 0 is false, and returns ZERO ROWS. That is precisely
--  what the API turns into a clean 409, with no order created.
-- ============================================================================

-- Decrement one unit if (and only if) one is available.
-- Returns the updated row, or no rows at all when out of stock.
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

-- Give a reserved unit back (payment failed, abandoned, or cancelled).
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

-- Sweep abandoned reservations.
--
-- Claims the expired rows FIRST by flipping their status, then credits stock.
-- Both happen in one transaction, so two overlapping cron runs cannot release
-- the same unit twice — the second run no longer sees those rows as reserved.
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
--  5. ROW LEVEL SECURITY
--
--  The API routes use the secret (service-role) key, which bypasses RLS
--  entirely. RLS is enabled anyway so that a leaked publishable key cannot
--  read customer orders or touch stock. The browser never queries these
--  tables directly — everything goes through /api.
-- ============================================================================

alter table public.products enable row level security;
alter table public.orders   enable row level security;

drop policy if exists "products are publicly readable" on public.products;
create policy "products are publicly readable"
  on public.products for select
  to anon, authenticated
  using (true);

-- Deliberately NO policy on orders => the publishable key can do nothing
-- with them: no select, no insert, no update.

-- ============================================================================
--  6. SEED DATA — 15 products
--
--  Prices are in PAISE. 89900 = ₹899.
--  Wipes and reloads, so re-running this file gives you a clean catalogue.
-- ============================================================================

delete from public.orders;
delete from public.products;

insert into public.products (name, description, price, size, color, image_url, stock_count, status) values
  ('Heavyweight Cotton Tee',
   '240 GSM combed cotton, boxy fit, pre-shrunk. The plain white tee that survives the wash cycle.',
   89900, 'M', 'White',
   'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=80', 24, 'available'),

  ('Heavyweight Cotton Tee',
   '240 GSM combed cotton, boxy fit, pre-shrunk. The plain black tee that survives the wash cycle.',
   89900, 'L', 'Black',
   'https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=800&q=80', 18, 'available'),

  ('Faded Wash Oversized Tee',
   'Garment-dyed for an uneven vintage fade. Drop shoulder, wide body.',
   109900, 'XL', 'Olive',
   'https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=800&q=80', 12, 'available'),

  ('Fleece-Back Pullover Hoodie',
   '400 GSM brushed fleece interior, kangaroo pocket, ribbed cuffs that keep their shape.',
   249900, 'M', 'Charcoal',
   'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=80', 9, 'available'),

  ('Fleece-Back Pullover Hoodie',
   '400 GSM brushed fleece interior, kangaroo pocket, ribbed cuffs that keep their shape.',
   249900, 'L', 'Navy',
   'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=800&q=80', 6, 'available'),

  ('Zip-Through Hoodie',
   'Full YKK zip, double-lined hood, side seam pockets. Mid-weight, wears year round.',
   279900, 'XL', 'Grey',
   'https://images.unsplash.com/photo-1578681994506-b8f463449011?w=800&q=80', 4, 'available'),

  ('Ribbed Knit Crewneck',
   'Merino-cotton blend, fine gauge rib, no itch. Layers under a jacket without bulk.',
   329900, 'S', 'Cream',
   'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=800&q=80', 7, 'available'),

  ('Ribbed Knit Crewneck',
   'Merino-cotton blend, fine gauge rib, no itch. Layers under a jacket without bulk.',
   329900, 'M', 'Rust',
   'https://images.unsplash.com/photo-1516762689617-e1cffcef479d?w=800&q=80', 5, 'available'),

  ('Washed Denim Trucker Jacket',
   '12oz rigid denim, stone washed. Copper rivets, four pockets, gets better with wear.',
   449900, 'L', 'Indigo',
   'https://images.unsplash.com/photo-1543087903-1ac2ec7aa8c5?w=800&q=80', 3, 'available'),

  ('Relaxed Chino Trousers',
   'Cotton twill with 2% elastane, straight leg, no-break hem. Office-adjacent.',
   319900, '32', 'Khaki',
   'https://images.unsplash.com/photo-1473966968600-fa801b869a1a?w=800&q=80', 11, 'available'),

  ('Relaxed Chino Trousers',
   'Cotton twill with 2% elastane, straight leg, no-break hem. Office-adjacent.',
   319900, '34', 'Black',
   'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=800&q=80', 8, 'available'),

  ('Cuffed Jogger Sweatpants',
   'Matches the fleece-back hoodie. Elastic waist with drawcord, tapered leg, zip pocket.',
   199900, 'M', 'Charcoal',
   'https://images.unsplash.com/photo-1552902865-b72c031ac5ea?w=800&q=80', 14, 'available'),

  ('Striped Long Sleeve Tee',
   'Breton stripe on midweight jersey. Boat neck, slightly cropped sleeve.',
   139900, 'S', 'Navy',
   'https://images.unsplash.com/photo-1622445275576-721325763afe?w=800&q=80', 10, 'available'),

  ('Corduroy Overshirt',
   '8-wale cotton corduroy, chest pockets, horn-look buttons. Shirt or light jacket.',
   389900, 'L', 'Tan',
   'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?w=800&q=80', 2, 'available'),

  -- ⚠️ THE RACE-CONDITION TEST ITEM. Exactly one unit, on purpose.
  --    Two concurrent buyers: one gets 201, the other MUST get a clean 409.
  ('Hand-Dyed Indigo Shibori Tee — Last One',
   'One-off dye run, no restock. Deliberately seeded with a single unit so the concurrent-checkout path can be tested: buy it in two tabs at once and the second attempt must fail with 409, not oversell.',
   159900, 'M', 'Indigo',
   'https://images.unsplash.com/photo-1503341504253-dff4815485f1?w=800&q=80', 1, 'available');

-- ============================================================================
--  7. VERIFICATION
--
--  Every row below must read PASS. If anything says FAIL, the setup is not
--  complete and the API will error — re-run this whole file.
-- ============================================================================

with checks as (
  select 1 as ord, 'products table' as item,
         (select count(*)::text from public.products) || ' rows' as detail,
         (select count(*) from public.products) = 15 as pass
  union all
  select 2, 'orders table',
         'exists, ' || (select count(*)::text from public.orders) || ' rows',
         to_regclass('public.orders') is not null
  union all
  select 3, 'race-test item (stock = 1)',
         coalesce((select name from public.products where stock_count = 1 limit 1), 'NOT FOUND'),
         (select count(*) from public.products where stock_count = 1) >= 1
  union all
  select 4, 'fn reserve_product_stock',
         'atomic conditional UPDATE',
         to_regprocedure('public.reserve_product_stock(uuid)') is not null
  union all
  select 5, 'fn release_product_stock',
         'returns stock on failure',
         to_regprocedure('public.release_product_stock(uuid)') is not null
  union all
  select 6, 'fn cancel_expired_orders',
         'expiry sweeper',
         to_regprocedure('public.cancel_expired_orders(integer)') is not null
  union all
  select 7, 'RLS enabled on both tables',
         'publishable key cannot touch orders',
         (select bool_and(rowsecurity) from pg_tables
           where schemaname = 'public' and tablename in ('products','orders'))
  union all
  select 8, 'stock_count >= 0 constraint',
         'overselling is impossible at the DB level',
         exists (select 1 from pg_constraint where conname = 'products_stock_non_negative')
  union all
  select 9, 'total units in stock',
         (select sum(stock_count)::text from public.products) || ' units',
         (select sum(stock_count) from public.products) > 0
)
select
  case when bool_and(pass) then '✅ SETUP OK' else '❌ SETUP INCOMPLETE' end as result,
  string_agg(
    case when pass then '  PASS  ' else '  FAIL  ' end || rpad(item, 30) || detail,
    E'\n' order by ord
  ) as details
from checks;
