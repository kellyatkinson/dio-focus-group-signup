-- Run this in Supabase SQL Editor only if you need a clean slate.
-- It drops all schema objects created by this project, including responses.

drop trigger  if exists enforce_email_domain_on_signup on auth.users;
drop function if exists public.enforce_email_domain();
drop function if exists public.save_my_availability(text, uuid[]);
drop function if exists public.save_my_availability(text, jsonb);
drop function if exists public.admin_get_availability_summary();
drop function if exists public.admin_get_all_responses();
drop function if exists public.admin_set_group_final_time(text, uuid, text, text);
drop function if exists public.is_admin_email(text);

drop table if exists public.availability cascade;
drop table if exists public.respondents cascade;
drop table if exists public.focus_groups cascade;
drop table if exists public.time_options cascade;
drop table if exists public.admins cascade;
drop table if exists public.settings cascade;
