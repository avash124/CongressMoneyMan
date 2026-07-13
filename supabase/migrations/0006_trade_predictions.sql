create table if not exists trade_predictions (
  bioguide_id   text not null,             
  ticker        text not null,             
  rank          integer not null,          
  score         numeric not null,          
  p_buy         numeric,                   
  as_of         date not null,           
  model_version text not null,             
  computed_at   timestamptz not null default now(),
  primary key (bioguide_id, ticker, as_of)
);

create index if not exists trade_predictions_bioguide_as_of_idx
  on trade_predictions (bioguide_id, as_of);
