create table if not exists trade_features (
  feature_id        text primary key,          
  scope             text not null,            
  entity_key        text not null,            
  display_name      text,
  party             text,                      
  chamber           text,                      
  sector            text,                      
  asset_type        text,                      
  trade_count       integer not null default 0,
  buy_count         integer not null default 0,
  sell_count        integer not null default 0,
  buy_sell_ratio    numeric,                  
  first_trade_date  text,
  last_trade_date   text,
  trades_per_month  numeric,
  matched_pairs     integer not null default 0,
  avg_holding_days  numeric,                   
  total_bought_usd  numeric not null default 0,
  total_sold_usd    numeric not null default 0,
  priced_buy_usd    numeric,                   
  est_pl_pct        numeric,                   
  est_pl_usd        numeric,
  spy_pl_pct        numeric,                  
  excess_return_pct numeric,                   
  top_sectors       jsonb,                     
  asset_types       jsonb,                     
  member_count      integer,                   
  house_count       integer,
  senate_count      integer,
  computed_at       timestamptz not null default now()
);

create index if not exists trade_features_scope_asset_type_idx
  on trade_features (scope, asset_type);


create table if not exists asset_class_stats (
  asset_type       text primary key,           
  trade_count      integer not null default 0,
  buy_count        integer not null default 0,
  sell_count       integer not null default 0,
  member_count     integer not null default 0,
  total_bought_usd numeric not null default 0,
  total_sold_usd   numeric not null default 0,
  first_trade_date text,
  last_trade_date  text,
  by_chamber       jsonb,                      
  by_party         jsonb,                     
  top_tickers      jsonb,                     
  computed_at      timestamptz not null default now()
);
