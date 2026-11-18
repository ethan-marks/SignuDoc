-- Public API: keys, the link from an envelope to the system that created it,
-- webhook endpoints and the deliveries sent to them.

create table if not exists public.api_keys (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  name text not null,
  -- The first characters of the key, shown in the list so a key can be
  -- recognised. The key itself is never stored, only its SHA-256 hash.
  key_prefix text not null,
  key_hash text not null unique check (length(key_hash) = 64),
  created_at bigint not null default (extract(epoch from now())::bigint),
  last_used_at bigint,
  revoked_at bigint
);

create index if not exists api_keys_user_idx on public.api_keys (user_id);

create table if not exists public.api_envelopes (
  envelope_id text primary key references public.envelopes(id) on delete cascade,
  api_key_id text references public.api_keys(id) on delete set null,
  -- The caller's own id for this envelope, such as a contract number.
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at bigint not null default (extract(epoch from now())::bigint)
);

create index if not exists api_envelopes_reference_idx
  on public.api_envelopes (external_reference)
  where external_reference is not null;

create table if not exists public.webhook_endpoints (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  url text not null,
  secret text not null,
  active boolean not null default true,
  created_at bigint not null default (extract(epoch from now())::bigint)
);

create index if not exists webhook_endpoints_user_idx
  on public.webhook_endpoints (user_id);

create table if not exists public.webhook_deliveries (
  id text primary key,
  endpoint_id text not null references public.webhook_endpoints(id) on delete cascade,
  -- Not a foreign key: the delivery record outlives a deleted envelope.
  envelope_id text not null,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at bigint,
  last_status_code integer,
  last_error text,
  created_at bigint not null default (extract(epoch from now())::bigint),
  delivered_at bigint
);

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status = 'pending';
