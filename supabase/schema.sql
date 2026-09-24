-- =============================================================================================
-- Bug Busters: paste this whole file into Supabase -> SQL Editor -> Run. Safe to run again.
--
-- Security model
--   * Students never sign in. They can read published problems and call the bb_* functions
--     below, which check that the laptop (device key) matches the register number.
--   * Inspectors sign in with email + password AND must be listed in public.inspectors.
--   * The unlock PIN lives in the private schema, which the public API cannot read.
-- =============================================================================================

create schema if not exists private;

create table if not exists private.config (
  id int primary key default 1 check (id = 1),
  unlock_pin text not null default '2609'
);
insert into private.config (id) values (1) on conflict do nothing;
alter table private.config enable row level security;   -- no policies: only the bb_* functions read it

create table if not exists public.inspectors (email text primary key);

create or replace function public.is_inspector() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.inspectors
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  title text not null default 'Bug Busters',
  ends_at timestamptz,
  is_open boolean not null default true,
  grace_seconds int not null default 120   -- accepts submissions queued offline just before the end
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.problems (
  id bigint generated always as identity primary key,
  position int not null default 0,
  title text not null,
  statement text not null default '',
  buggy_code text not null default '',
  max_marks numeric not null default 10,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.solutions (
  problem_id bigint primary key references public.problems on delete cascade,
  code text not null default ''
);

create table if not exists public.students (
  reg_no text primary key,
  name text not null,
  device_key uuid,                          -- null = released, next laptop to log in claims it
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.submissions (
  id bigint generated always as identity primary key,
  reg_no text not null references public.students on delete cascade,
  problem_id bigint not null references public.problems on delete cascade,
  code text not null,
  version int not null default 1,
  submitted_at timestamptz not null default now(),
  marks numeric,
  comment text,
  marked_version int,
  marked_at timestamptz,
  marked_by text,
  unique (reg_no, problem_id)
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  reg_no text,
  name text,
  type text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------- RLS
alter table public.inspectors  enable row level security;
alter table public.settings    enable row level security;
alter table public.problems    enable row level security;
alter table public.solutions   enable row level security;
alter table public.students    enable row level security;
alter table public.submissions enable row level security;
alter table public.events      enable row level security;

drop policy if exists "inspectors read" on public.inspectors;
create policy "inspectors read" on public.inspectors for select to authenticated using (public.is_inspector());

drop policy if exists "anyone reads settings" on public.settings;
create policy "anyone reads settings" on public.settings for select to anon, authenticated using (true);
drop policy if exists "inspectors edit settings" on public.settings;
create policy "inspectors edit settings" on public.settings for update to authenticated
  using (public.is_inspector()) with check (public.is_inspector());

drop policy if exists "read published problems" on public.problems;
create policy "read published problems" on public.problems for select to anon, authenticated
  using (published or public.is_inspector());
drop policy if exists "inspectors manage problems" on public.problems;
create policy "inspectors manage problems" on public.problems for all to authenticated
  using (public.is_inspector()) with check (public.is_inspector());

do $$
declare t text;
begin
  foreach t in array array['solutions', 'students', 'submissions', 'events'] loop
    execute format('drop policy if exists "inspectors manage %1$s" on public.%1$I', t);
    execute format('create policy "inspectors manage %1$s" on public.%1$I for all to authenticated
                    using (public.is_inspector()) with check (public.is_inspector())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------- student API
create or replace function public.bb_state() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'now', now(), 'title', s.title, 'ends_at', s.ends_at, 'is_open', s.is_open,
    -- lets a locked laptop verify the PIN while the internet is down
    'pin_hash', encode(sha256(convert_to(c.unlock_pin || ':bugbusters', 'UTF8')), 'hex'))
  from public.settings s, private.config c where s.id = 1 and c.id = 1;
$$;

create or replace function public.bb_join(p_reg text, p_name text, p_device uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  s public.students;
  reg text := upper(regexp_replace(coalesce(p_reg, ''), '\s', '', 'g'));
  nm  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if reg = '' or nm = '' or length(reg) > 32 or length(nm) > 80 then
    raise exception 'Enter your full name and register number.';
  end if;
  select * into s from public.students where reg_no = reg;
  if not found then
    insert into public.students (reg_no, name, device_key) values (reg, nm, p_device);
  elsif s.device_key is not null and s.device_key <> p_device then
    raise exception 'Register number % is already logged in on another laptop. Ask an invigilator to release it.', reg;
  else
    update public.students set device_key = p_device, name = nm, last_seen = now() where reg_no = reg;
  end if;
  return json_build_object('reg_no', reg, 'name', nm, 'submissions', coalesce((
    select json_agg(json_build_object('problem_id', problem_id, 'version', version, 'submitted_at', submitted_at))
    from public.submissions where reg_no = reg), '[]'::json));
end $$;

create or replace function public._bb_student(p_reg text, p_device uuid) returns public.students
language plpgsql security definer set search_path = public as $$
declare s public.students;
begin
  select * into s from public.students where reg_no = p_reg and device_key = p_device;
  if not found then raise exception 'This laptop is not logged in as %. Log in again.', p_reg; end if;
  return s;
end $$;

create or replace function public.bb_submit(p_reg text, p_device uuid, p_problem bigint, p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare st public.settings; r public.submissions;
begin
  perform public._bb_student(p_reg, p_device);
  select * into st from public.settings where id = 1;
  if not st.is_open or (st.ends_at is not null and now() > st.ends_at + make_interval(secs => st.grace_seconds)) then
    raise exception 'Time is up. Submissions are closed.';
  end if;
  perform 1 from public.problems where id = p_problem and published;
  if not found then raise exception 'This question is not available.'; end if;
  if length(p_code) > 50000 then raise exception 'Code is too long.'; end if;
  insert into public.submissions (reg_no, problem_id, code) values (p_reg, p_problem, p_code)
  on conflict (reg_no, problem_id) do update
    set code = excluded.code, submitted_at = now(), version = public.submissions.version + 1
  returning * into r;
  update public.students set last_seen = now() where reg_no = p_reg;
  return json_build_object('problem_id', r.problem_id, 'version', r.version, 'submitted_at', r.submitted_at);
end $$;

create or replace function public.bb_event(p_reg text, p_device uuid, p_type text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.students;
begin
  s := public._bb_student(p_reg, p_device);
  insert into public.events (reg_no, name, type) values (s.reg_no, s.name, left(coalesce(p_type, ''), 160));
end $$;

create or replace function public.bb_unlock(p_pin text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_pin, '') = unlock_pin from private.config where id = 1;
$$;

create or replace function public.bb_set_pin(p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_inspector() then raise exception 'Inspectors only.'; end if;
  if length(coalesce(p_pin, '')) < 4 then raise exception 'PIN must be at least 4 characters.'; end if;
  update private.config set unlock_pin = p_pin where id = 1;
end $$;

revoke execute on function public._bb_student(text, uuid) from anon, authenticated, public;
grant execute on function public.bb_state(), public.bb_join(text, text, uuid),
  public.bb_submit(text, uuid, bigint, text), public.bb_event(text, uuid, text),
  public.bb_unlock(text) to anon, authenticated;
grant execute on function public.bb_set_pin(text) to authenticated;

-- ---------------------------------------------------------------------------------- example problem
insert into public.problems (position, title, statement, buggy_code, max_marks, published)
select 1, 'Syntax Slip',
'Load the ECG record from `signal.mat` (variable `ecg`, 360 Hz), smooth it with an **8-point moving average**, plot it and print a few statistics. The script has **3 bugs**.',
E'% debug_me.m  -  smooth a raw ECG and plot it\nx = load(''signal.mat'');\nfs = 360;\nb = ones(1, 8) / 8;          % 8-point moving average\na = 1;\ny = filter(b, a, x]\nt = (0:length(y)) / fs;\nplot(t, y);\nxlabel(''Time (s)''); ylabel(''Amplitude (mV)'');\ntitle(''Smoothed ECG'');\nfprintf(''Samples      : %d\\n'', length(y));\nfprintf(''Duration (s) : %.4f\\n'', t(end));\nfprintf(''Mean (mV)    : %.4f\\n'', mean(y));\n',
10, true
where not exists (select 1 from public.problems);

insert into public.solutions (problem_id, code)
select id,
E'% debug_me.m  -  smooth a raw ECG and plot it\ndata = load(''signal.mat'');\nx = data.ecg;\nfs = 360;\nb = ones(1, 8) / 8;          % 8-point moving average\na = 1;\ny = filter(b, a, x);\nt = (0:length(y)-1) / fs;\nplot(t, y);\nxlabel(''Time (s)''); ylabel(''Amplitude (mV)'');\ntitle(''Smoothed ECG'');\nfprintf(''Samples      : %d\\n'', length(y));\nfprintf(''Duration (s) : %.4f\\n'', t(end));\nfprintf(''Mean (mV)    : %.4f\\n'', mean(y));\n'
from public.problems where title = 'Syntax Slip'
on conflict do nothing;

-- ---------------------------------------------------------------------------------- inspectors
-- After creating the inspector account(s) in Authentication -> Users, list their emails here:
-- insert into public.inspectors (email) values ('inspector@example.com') on conflict do nothing;
