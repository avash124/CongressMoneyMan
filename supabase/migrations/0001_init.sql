-- CongressMoneyMan persistence schema.
--
-- Apply once via the Supabase SQL editor (or `supabase db push`). The app reads
-- and writes these tables through lib/db.ts using the service-role key, so Row
-- Level Security can stay enabled with no policies — server access bypasses it.
--
-- `bioguide_id` is the logical key across tables; there are intentionally NO
-- cross-table foreign keys so the ETL jobs can run in any order.

-- One row per current House/Senate member.
create table if not exists members (
  bioguide_id  text primary key,
  name         text not null,
  party        text not null,             -- 'D' | 'R' | 'I'
  state        text not null,
  district     text,                       -- null for senators
  chamber      text not null,             -- 'house' | 'senate'
  last_updated timestamptz not null default now()
);

-- One row per disclosed congressional trade (keyed on Quiver's UniqueID).
create table if not exists trades (
  trade_id         text primary key,
  bioguide_id      text not null,
  member_name      text,
  party            text,
  chamber          text,
  ticker           text,
  asset_name       text,
  asset_type       text,
  transaction_type text,
  transaction_date text,
  traded           text,
  range_text       text,
  trade_size_usd   numeric,
  filed_at         text,
  inserted_at      timestamptz not null default now()
);

create index if not exists trades_bioguide_id_idx on trades (bioguide_id);

-- Live net-worth / stock-holdings snapshot per member (drives the rankings).
create table if not exists portfolio_data (
  bioguide_id    text primary key,
  net_worth      numeric,
  stock_holdings numeric,
  fetched_at     timestamptz not null default now()
);

-- Resolved FEC candidate + headline totals per member.
create table if not exists fec_candidates (
  bioguide_id   text primary key,
  candidate_id  text,
  committee_ids text[] not null default '{}',
  total_raised  numeric not null default 0,
  total_spent   numeric not null default 0,
  cycle         integer,
  fetched_at    timestamptz not null default now()
);

-- Per-donor aggregated PAC contributions (top donors + industry classification).
create table if not exists pac_donations (
  id          bigint generated always as identity primary key,
  bioguide_id text not null,
  pac_name    text not null,
  amount      numeric not null default 0,
  cycle       integer,
  fetched_at  timestamptz not null default now()
);

create index if not exists pac_donations_bioguide_id_idx on pac_donations (bioguide_id);
