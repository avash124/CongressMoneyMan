create table if not exists members (
  bioguide_id  text primary key,
  name         text not null,
  party        text not null,             
  state        text not null,
  district     text,                       
  chamber      text not null,             
  last_updated timestamptz not null default now()
);
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

create table if not exists pac_donations (
  id          bigint generated always as identity primary key,
  bioguide_id text not null,
  pac_name    text not null,
  amount      numeric not null default 0,
  cycle       integer,
  fetched_at  timestamptz not null default now()
);

create index if not exists pac_donations_bioguide_id_idx on pac_donations (bioguide_id);
