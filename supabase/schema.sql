-- =====================================================================
-- Focus Group Scheduler - Database Schema
-- =====================================================================
-- Run top-to-bottom in Supabase SQL Editor.
-- For a clean slate, run supabase/drop_all.sql first.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.focus_groups (
  id                   text primary key,
  name                 text not null,
  description          text,
  display_order        smallint not null,
  final_time_option_id uuid,
  final_location       text,
  final_note           text,
  finalised_at         timestamptz,
  finalised_by_email   text
);

create table if not exists public.time_options (
  id            uuid primary key default gen_random_uuid(),
  label         text not null,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  display_order smallint not null,
  active        boolean not null default true,
  constraint time_options_end_after_start check (ends_at > starts_at)
);

alter table public.focus_groups
  drop constraint if exists focus_groups_final_time_option_id_fkey;

alter table public.focus_groups
  add constraint focus_groups_final_time_option_id_fkey
  foreign key (final_time_option_id) references public.time_options(id)
  on delete set null;

create table if not exists public.respondents (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  group_id     text not null references public.focus_groups(id),
  user_email   text not null,
  user_name    text,
  submitted_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.availability (
  user_id        uuid not null references public.respondents(user_id) on delete cascade,
  time_option_id uuid not null references public.time_options(id) on delete cascade,
  status         text not null default 'available',
  created_at     timestamptz not null default now(),
  primary key (user_id, time_option_id)
);

alter table public.availability
  add column if not exists status text not null default 'available';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_status_check'
      and conrelid = 'public.availability'::regclass
  ) then
    alter table public.availability
      add constraint availability_status_check
      check (status in ('available', 'if_needed'));
  end if;
end;
$$;

create table if not exists public.settings (
  key   text primary key,
  value text not null
);

create table if not exists public.admins (
  email text primary key
);

create index if not exists respondents_group_id_idx on public.respondents(group_id);
create index if not exists availability_time_option_id_idx on public.availability(time_option_id);

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------
-- Replace the groups/admins/settings with your real focus-group plan.
-- The time options below are the requested 30-minute windows for 18-20 May.

insert into public.focus_groups (id, name, description, display_order) values
  ('juniorschool', 'Junior School teaching & admin', '', 1),
  ('seniorschool', 'Senior School teaching & admin', '', 2),
  ('admin', 'Admin, Attendance, Student Services', '', 3),
  ('ea', 'Executive Assistants & Personal Assistants', '', 4),
  ('pastoral', 'Pastoral, Wellbeing, Boarding', '', 5),
  ('people', 'People Processes', 'People & Culture, HR, Payroll', 6),
  ('business', 'Business Services', 'Finance, Business, Property', 7),
  ('development', 'Admission, Enrolment, Development', 'including international & community engagement', 8),
  ('cocurricular', 'Co-curricular, Sport, Perf Arts, EOTC', 'including activity operations', 9),
  ('systems', 'Systems, data, timetabling, eLearning', '', 10)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  display_order = excluded.display_order;

insert into public.time_options (id, label, starts_at, ends_at, display_order, active) values
  ('00000000-0000-0000-0000-000000000101', 'Mon 18 May 11:00am', '2026-05-18T11:00:00+12:00', '2026-05-18T11:30:00+12:00', 1, true),
  ('00000000-0000-0000-0000-000000000102', 'Mon 18 May 11:30am', '2026-05-18T11:30:00+12:00', '2026-05-18T12:00:00+12:00', 2, true),
  ('00000000-0000-0000-0000-000000000103', 'Mon 18 May 1:00pm',  '2026-05-18T13:00:00+12:00', '2026-05-18T13:30:00+12:00', 3, true),
  ('00000000-0000-0000-0000-000000000104', 'Mon 18 May 1:30pm',  '2026-05-18T13:30:00+12:00', '2026-05-18T14:00:00+12:00', 4, true),
  ('00000000-0000-0000-0000-000000000105', 'Mon 18 May 2:00pm',  '2026-05-18T14:00:00+12:00', '2026-05-18T14:30:00+12:00', 5, true),
  ('00000000-0000-0000-0000-000000000106', 'Mon 18 May 2:30pm',  '2026-05-18T14:30:00+12:00', '2026-05-18T15:00:00+12:00', 6, true),
  ('00000000-0000-0000-0000-000000000107', 'Tue 19 May 10:00am', '2026-05-19T10:00:00+12:00', '2026-05-19T10:30:00+12:00', 7, true),
  ('00000000-0000-0000-0000-000000000108', 'Tue 19 May 10:30am', '2026-05-19T10:30:00+12:00', '2026-05-19T11:00:00+12:00', 8, true),
  ('00000000-0000-0000-0000-000000000109', 'Tue 19 May 11:00am', '2026-05-19T11:00:00+12:00', '2026-05-19T11:30:00+12:00', 9, true),
  ('00000000-0000-0000-0000-000000000110', 'Tue 19 May 11:30am', '2026-05-19T11:30:00+12:00', '2026-05-19T12:00:00+12:00', 10, true),
  ('00000000-0000-0000-0000-000000000111', 'Tue 19 May 12:00pm', '2026-05-19T12:00:00+12:00', '2026-05-19T12:30:00+12:00', 11, true),
  ('00000000-0000-0000-0000-000000000112', 'Tue 19 May 12:30pm', '2026-05-19T12:30:00+12:00', '2026-05-19T13:00:00+12:00', 12, true),
  ('00000000-0000-0000-0000-000000000113', 'Tue 19 May 1:00pm',  '2026-05-19T13:00:00+12:00', '2026-05-19T13:30:00+12:00', 13, true),
  ('00000000-0000-0000-0000-000000000114', 'Tue 19 May 1:30pm',  '2026-05-19T13:30:00+12:00', '2026-05-19T14:00:00+12:00', 14, true),
  ('00000000-0000-0000-0000-000000000115', 'Tue 19 May 2:00pm',  '2026-05-19T14:00:00+12:00', '2026-05-19T14:30:00+12:00', 15, true),
  ('00000000-0000-0000-0000-000000000116', 'Tue 19 May 2:30pm',  '2026-05-19T14:30:00+12:00', '2026-05-19T15:00:00+12:00', 16, true),
  ('00000000-0000-0000-0000-000000000117', 'Tue 19 May 3:00pm',  '2026-05-19T15:00:00+12:00', '2026-05-19T15:30:00+12:00', 17, true),
  ('00000000-0000-0000-0000-000000000118', 'Tue 19 May 3:30pm',  '2026-05-19T15:30:00+12:00', '2026-05-19T16:00:00+12:00', 18, true),
  ('00000000-0000-0000-0000-000000000119', 'Wed 20 May 10:00am', '2026-05-20T10:00:00+12:00', '2026-05-20T10:30:00+12:00', 19, true),
  ('00000000-0000-0000-0000-000000000120', 'Wed 20 May 10:30am', '2026-05-20T10:30:00+12:00', '2026-05-20T11:00:00+12:00', 20, true),
  ('00000000-0000-0000-0000-000000000121', 'Wed 20 May 11:00am', '2026-05-20T11:00:00+12:00', '2026-05-20T11:30:00+12:00', 21, true),
  ('00000000-0000-0000-0000-000000000122', 'Wed 20 May 11:30am', '2026-05-20T11:30:00+12:00', '2026-05-20T12:00:00+12:00', 22, true),
  ('00000000-0000-0000-0000-000000000123', 'Wed 20 May 12:00pm', '2026-05-20T12:00:00+12:00', '2026-05-20T12:30:00+12:00', 23, true),
  ('00000000-0000-0000-0000-000000000124', 'Wed 20 May 12:30pm', '2026-05-20T12:30:00+12:00', '2026-05-20T13:00:00+12:00', 24, true),
  ('00000000-0000-0000-0000-000000000125', 'Wed 20 May 1:00pm',  '2026-05-20T13:00:00+12:00', '2026-05-20T13:30:00+12:00', 25, true),
  ('00000000-0000-0000-0000-000000000126', 'Wed 20 May 1:30pm',  '2026-05-20T13:30:00+12:00', '2026-05-20T14:00:00+12:00', 26, true),
  ('00000000-0000-0000-0000-000000000127', 'Wed 20 May 2:00pm',  '2026-05-20T14:00:00+12:00', '2026-05-20T14:30:00+12:00', 27, true),
  ('00000000-0000-0000-0000-000000000128', 'Wed 20 May 2:30pm',  '2026-05-20T14:30:00+12:00', '2026-05-20T15:00:00+12:00', 28, true),
  ('00000000-0000-0000-0000-000000000129', 'Wed 20 May 3:00pm',  '2026-05-20T15:00:00+12:00', '2026-05-20T15:30:00+12:00', 29, true),
  ('00000000-0000-0000-0000-000000000130', 'Wed 20 May 3:30pm',  '2026-05-20T15:30:00+12:00', '2026-05-20T16:00:00+12:00', 30, true)
on conflict (id) do update set
  label = excluded.label,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  display_order = excluded.display_order,
  active = excluded.active;

insert into public.settings (key, value) values
  ('app_title', 'Focus Group Scheduler'),
  ('organisation_name', 'Diocesan School for Girls'),
  ('email_domain', 'diocesan.school.nz'),
  ('response_cutoff_iso', '2026-05-17T23:59:59+12:00')
on conflict (key) do update set
  value = excluded.value;

insert into public.admins (email) values
  ('katkinson@diocesan.school.nz')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- Auth domain restriction
-- ---------------------------------------------------------------------

create or replace function public.enforce_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_domain text;
begin
  select value into allowed_domain from public.settings where key = 'email_domain';
  if allowed_domain is not null
     and (new.email is null or new.email not ilike '%@' || allowed_domain) then
    raise exception 'Only @% accounts may use this app.', allowed_domain;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_email_domain_on_signup on auth.users;
create trigger enforce_email_domain_on_signup
  before insert on auth.users
  for each row execute function public.enforce_email_domain();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create or replace function public.is_admin_email(p_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where lower(email) = lower(coalesce(p_email, ''))
  );
$$;

-- ---------------------------------------------------------------------
-- Respondent RPC
-- ---------------------------------------------------------------------

drop function if exists public.save_my_availability(text, uuid[]);

create or replace function public.save_my_availability(
  p_group_id text,
  p_availability jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id        uuid := auth.uid();
  v_user_email     text := auth.jwt()->>'email';
  v_user_name      text;
  v_domain         text;
  v_cutoff         timestamptz;
  v_payload        jsonb := coalesce(p_availability, '[]'::jsonb);
  v_row_count      int;
  v_input_count    int;
  v_valid_count    int;
  v_invalid_count  int;
begin
  if v_user_id is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select value into v_domain from public.settings where key = 'email_domain';
  if v_domain is not null and v_user_email !~* ('@' || v_domain || '$') then
    return json_build_object('ok', false, 'error', 'wrong_domain');
  end if;

  select value::timestamptz into v_cutoff
  from public.settings
  where key = 'response_cutoff_iso';

  if v_cutoff is not null and now() >= v_cutoff then
    return json_build_object('ok', false, 'error', 'editing_closed');
  end if;

  if not exists (select 1 from public.focus_groups where id = p_group_id) then
    return json_build_object('ok', false, 'error', 'invalid_group');
  end if;

  if jsonb_typeof(v_payload) <> 'array' then
    return json_build_object('ok', false, 'error', 'invalid_availability');
  end if;

  with raw as (
    select
      item->>'time_option_id' as time_option_id_text,
      item->>'status' as status
    from jsonb_array_elements(v_payload) as item
  )
  select count(*) into v_invalid_count
  from raw
  where status not in ('available', 'if_needed')
     or time_option_id_text is null
     or time_option_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if v_invalid_count > 0 then
    return json_build_object('ok', false, 'error', 'invalid_availability');
  end if;

  with raw as (
    select
      item->>'time_option_id' as time_option_id_text,
      item->>'status' as status
    from jsonb_array_elements(v_payload) as item
  )
  select count(*), count(distinct time_option_id_text)
    into v_row_count, v_input_count
  from raw;

  if v_row_count <> v_input_count then
    return json_build_object('ok', false, 'error', 'duplicate_time_option');
  end if;

  select count(distinct id) into v_valid_count
  from public.time_options
  where active is true
    and id in (
      select (item->>'time_option_id')::uuid
      from jsonb_array_elements(v_payload) as item
    );

  if v_input_count <> v_valid_count then
    return json_build_object('ok', false, 'error', 'invalid_time_option');
  end if;

  select coalesce(
           raw_user_meta_data->>'full_name',
           raw_user_meta_data->>'name',
           email
         )
    into v_user_name
    from auth.users
   where id = v_user_id;

  insert into public.respondents (
    user_id,
    group_id,
    user_email,
    user_name,
    submitted_at,
    updated_at
  )
  values (
    v_user_id,
    p_group_id,
    v_user_email,
    v_user_name,
    now(),
    now()
  )
  on conflict (user_id) do update set
    group_id = excluded.group_id,
    user_email = excluded.user_email,
    user_name = excluded.user_name,
    updated_at = now();

  delete from public.availability
  where user_id = v_user_id;

  insert into public.availability (user_id, time_option_id, status)
  select
    v_user_id,
    (item->>'time_option_id')::uuid,
    item->>'status'
  from jsonb_array_elements(v_payload) as item;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.save_my_availability(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------

drop function if exists public.admin_get_availability_summary();

create or replace function public.admin_get_availability_summary()
returns table (
  group_id text,
  group_name text,
  group_description text,
  time_option_id uuid,
  time_label text,
  starts_at timestamptz,
  ends_at timestamptz,
  available_count int,
  if_needed_count int,
  unavailable_count int,
  total_in_group int,
  final_time_option_id uuid,
  final_location text,
  final_note text,
  finalised_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_email(auth.jwt()->>'email') then
    raise exception 'forbidden';
  end if;

  return query
    select
      g.id as group_id,
      g.name as group_name,
      g.description as group_description,
      t.id as time_option_id,
      t.label as time_label,
      t.starts_at,
      t.ends_at,
      (count(r.user_id) filter (where a.status = 'available'))::int as available_count,
      (count(r.user_id) filter (where a.status = 'if_needed'))::int as if_needed_count,
      (
        (
          select count(*)::int
          from public.respondents r_total
          where r_total.group_id = g.id
        )
        - (count(r.user_id) filter (where a.status = 'available'))::int
        - (count(r.user_id) filter (where a.status = 'if_needed'))::int
      ) as unavailable_count,
      (
        select count(*)::int
        from public.respondents r_total
        where r_total.group_id = g.id
      ) as total_in_group,
      g.final_time_option_id,
      g.final_location,
      g.final_note,
      g.finalised_at
    from public.focus_groups g
    cross join public.time_options t
    left join public.respondents r
      on r.group_id = g.id
    left join public.availability a
      on a.user_id = r.user_id
     and a.time_option_id = t.id
    where t.active is true
    group by
      g.id,
      g.name,
      g.description,
      g.display_order,
      t.id,
      t.label,
      t.starts_at,
      t.ends_at,
      t.display_order,
      g.final_time_option_id,
      g.final_location,
      g.final_note,
      g.finalised_at
    order by g.display_order, t.display_order, t.starts_at;
end;
$$;

grant execute on function public.admin_get_availability_summary() to authenticated;

drop function if exists public.admin_get_all_responses();

create or replace function public.admin_get_all_responses()
returns table (
  user_email text,
  user_name text,
  group_id text,
  group_name text,
  submitted_at timestamptz,
  updated_at timestamptz,
  available_time_option_ids uuid[],
  if_needed_time_option_ids uuid[],
  available_labels text[],
  if_needed_labels text[],
  unavailable_labels text[]
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_email(auth.jwt()->>'email') then
    raise exception 'forbidden';
  end if;

  return query
    select
      r.user_email,
      r.user_name,
      g.id as group_id,
      g.name as group_name,
      r.submitted_at,
      r.updated_at,
      coalesce(
        array(
          select a.time_option_id
          from public.availability a
          join public.time_options t on t.id = a.time_option_id
          where a.user_id = r.user_id
            and a.status = 'available'
          order by t.starts_at
        ),
        '{}'
      ) as available_time_option_ids,
      coalesce(
        array(
          select a.time_option_id
          from public.availability a
          join public.time_options t on t.id = a.time_option_id
          where a.user_id = r.user_id
            and a.status = 'if_needed'
          order by t.starts_at
        ),
        '{}'
      ) as if_needed_time_option_ids,
      coalesce(
        array(
          select t.label || ' - ' || to_char(t.starts_at at time zone 'Pacific/Auckland', 'Dy DD Mon HH24:MI')
          from public.availability a
          join public.time_options t on t.id = a.time_option_id
          where a.user_id = r.user_id
            and a.status = 'available'
          order by t.starts_at
        ),
        '{}'
      ) as available_labels,
      coalesce(
        array(
          select t.label || ' - ' || to_char(t.starts_at at time zone 'Pacific/Auckland', 'Dy DD Mon HH24:MI')
          from public.availability a
          join public.time_options t on t.id = a.time_option_id
          where a.user_id = r.user_id
            and a.status = 'if_needed'
          order by t.starts_at
        ),
        '{}'
      ) as if_needed_labels,
      coalesce(
        array(
          select t.label || ' - ' || to_char(t.starts_at at time zone 'Pacific/Auckland', 'Dy DD Mon HH24:MI')
          from public.time_options t
          where t.active is true
            and not exists (
              select 1
              from public.availability a
              where a.user_id = r.user_id
                and a.time_option_id = t.id
            )
          order by t.starts_at
        ),
        '{}'
      ) as unavailable_labels
    from public.respondents r
    join public.focus_groups g on g.id = r.group_id
    order by g.display_order, r.user_email;
end;
$$;

grant execute on function public.admin_get_all_responses() to authenticated;

create or replace function public.admin_set_group_final_time(
  p_group_id text,
  p_time_option_id uuid,
  p_location text default null,
  p_note text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_email(auth.jwt()->>'email') then
    raise exception 'forbidden';
  end if;

  if not exists (select 1 from public.focus_groups where id = p_group_id) then
    return json_build_object('ok', false, 'error', 'invalid_group');
  end if;

  if not exists (
    select 1
    from public.time_options
    where id = p_time_option_id
      and active is true
  ) then
    return json_build_object('ok', false, 'error', 'invalid_time_option');
  end if;

  update public.focus_groups
     set final_time_option_id = p_time_option_id,
         final_location = nullif(trim(coalesce(p_location, '')), ''),
         final_note = nullif(trim(coalesce(p_note, '')), ''),
         finalised_at = now(),
         finalised_by_email = auth.jwt()->>'email'
   where id = p_group_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.admin_set_group_final_time(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------

alter table public.focus_groups enable row level security;
alter table public.time_options enable row level security;
alter table public.respondents enable row level security;
alter table public.availability enable row level security;
alter table public.settings enable row level security;
alter table public.admins enable row level security;

drop policy if exists "focus groups readable" on public.focus_groups;
create policy "focus groups readable" on public.focus_groups
  for select to authenticated using (true);

drop policy if exists "time options readable" on public.time_options;
create policy "time options readable" on public.time_options
  for select to authenticated using (true);

drop policy if exists "settings readable" on public.settings;
create policy "settings readable" on public.settings
  for select to authenticated using (true);

drop policy if exists "users see own respondent row" on public.respondents;
create policy "users see own respondent row" on public.respondents
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "users see own availability" on public.availability;
create policy "users see own availability" on public.availability
  for select to authenticated
  using (user_id = auth.uid());

-- Writes go through SECURITY DEFINER RPCs.
drop policy if exists "admins table is private" on public.admins;
create policy "admins table is private" on public.admins
  for select to authenticated
  using (false);

-- ---------------------------------------------------------------------
-- Sanity checks
-- ---------------------------------------------------------------------
-- select count(*) from public.focus_groups;
-- select count(*) from public.time_options where active is true; -- expect 30
-- select * from public.admin_get_availability_summary();
