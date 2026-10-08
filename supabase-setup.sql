-- Bigasan Inventory — Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run again.

-- 1. One table holds everything: products, suppliers, stock balances, transactions, settings.
--    col = which list ("products", "txns", ...), id = the record's id, data = the record itself.
create table if not exists public.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists docs_txns_at   on public.docs ((data->>'at'))   where col = 'txns';
create index if not exists docs_txns_date on public.docs ((data->>'date')) where col = 'txns';

-- 2. Only signed-in users can read or change anything. Visitors without a login get nothing.
alter table public.docs enable row level security;
drop policy if exists "signed-in can read"   on public.docs;
drop policy if exists "signed-in can insert" on public.docs;
drop policy if exists "signed-in can update" on public.docs;
drop policy if exists "signed-in can delete" on public.docs;
create policy "signed-in can read"   on public.docs for select to authenticated using (true);
create policy "signed-in can insert" on public.docs for insert to authenticated with check (true);
create policy "signed-in can update" on public.docs for update to authenticated using (true) with check (true);
create policy "signed-in can delete" on public.docs for delete to authenticated using (true);
revoke all on public.docs from anon;

-- 3. Every stock change goes through this function. It locks the product's balance row,
--    checks each move, refuses anything that would go below zero, then writes the
--    transaction and the new balance together. Two phones saving at once cannot oversell.
create or replace function public.commit_txn(p_product text, p_txn_id text, p_moves jsonb, p_fields jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cur    jsonb;
  v_bodega numeric;
  v_stall  numeric;
  v_m      jsonb;
  v_loc    text;
  v_prev   numeric;
  v_delta  numeric;
  v_next   numeric;
  v_moves  jsonb := '[]'::jsonb;
  v_at     text  := to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_txn    jsonb;
begin
  if p_product is null or p_product = '' then raise exception 'BADINPUT:product'; end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then raise exception 'BADINPUT:moves'; end if;

  insert into docs (col, id, data) values ('stock', p_product, '{"bodega":0,"stall":0}'::jsonb)
    on conflict (col, id) do nothing;
  select data into v_cur from docs where col = 'stock' and id = p_product for update;

  v_bodega := round(coalesce((v_cur->>'bodega')::numeric, 0), 3);
  v_stall  := round(coalesce((v_cur->>'stall')::numeric, 0), 3);

  for v_m in select value from jsonb_array_elements(p_moves) loop
    v_loc := v_m->>'loc';
    if v_loc not in ('bodega', 'stall') then raise exception 'BADINPUT:loc'; end if;
    v_prev := case when v_loc = 'bodega' then v_bodega else v_stall end;
    if v_m ? 'setTo' and jsonb_typeof(v_m->'setTo') = 'number' then
      if (v_m->>'setTo')::numeric < 0 then raise exception 'BADINPUT:setTo'; end if;
      v_delta := round((v_m->>'setTo')::numeric - v_prev, 3);
      if abs(v_delta) < 0.0005 then continue; end if;
    else
      v_delta := round((v_m->>'kg')::numeric, 3);
    end if;
    v_next := round(v_prev + v_delta, 3);
    if v_next < -0.0005 then
      raise exception 'INSUFFICIENT:%:%', v_loc, v_prev;
    end if;
    if v_loc = 'bodega' then v_bodega := v_next; else v_stall := v_next; end if;
    v_moves := v_moves || jsonb_build_array(jsonb_build_object('loc', v_loc, 'kg', v_delta, 'prev', v_prev, 'next', v_next));
  end loop;

  if jsonb_array_length(v_moves) = 0 then raise exception 'NOCHANGE'; end if;

  v_txn := coalesce(p_fields, '{}'::jsonb)
           || jsonb_build_object('productId', p_product, 'moves', v_moves, 'at', v_at, 'by', auth.uid()::text);
  insert into docs (col, id, data) values ('txns', p_txn_id, v_txn);
  update docs
     set data = jsonb_build_object('bodega', v_bodega, 'stall', v_stall, 'updatedAt', v_at, 'lastTxn', p_txn_id),
         updated_at = now()
   where col = 'stock' and id = p_product;
  return jsonb_build_object('txn', v_txn,
                            'stock', jsonb_build_object('bodega', v_bodega, 'stall', v_stall, 'updatedAt', v_at, 'lastTxn', p_txn_id));
end;
$$;
revoke all on function public.commit_txn(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.commit_txn(text, text, jsonb, jsonb) to authenticated;

-- 4. Live updates: tell Supabase Realtime to broadcast changes to this table,
--    so the Stall phone sees a Bodega delivery within a second or two.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
