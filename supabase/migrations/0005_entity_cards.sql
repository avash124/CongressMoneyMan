create extension if not exists vector;

create table if not exists entity_cards (
  card_id    text primary key,          
  kind       text not null,             
  entity_key text not null,             
  card_text  text not null,
  embedding  vector(1024),
  updated_at timestamptz not null default now()
);

create index if not exists entity_cards_embedding_idx
  on entity_cards using hnsw (embedding vector_cosine_ops);

create or replace function match_entity_cards(
  query_embedding vector(1024),
  match_count int default 5
) returns table (
  card_id text,
  kind text,
  entity_key text,
  card_text text,
  similarity double precision
)
language sql stable as $$
  select entity_cards.card_id, entity_cards.kind, entity_cards.entity_key,
         entity_cards.card_text,
         1 - (entity_cards.embedding <=> query_embedding) as similarity
  from entity_cards
  where entity_cards.embedding is not null
  order by entity_cards.embedding <=> query_embedding
  limit match_count;
$$;
