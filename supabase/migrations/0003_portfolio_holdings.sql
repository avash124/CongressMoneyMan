create table if not exists portfolio_holdings (
  bioguide_id text not null,
  member_name text,
  party       text,                        
  chamber     text,                       
  ticker      text not null,
  value       numeric not null default 0,  
  fetched_at  timestamptz not null default now(),
  primary key (bioguide_id, ticker)
);

create index if not exists portfolio_holdings_ticker_idx on portfolio_holdings (ticker);
