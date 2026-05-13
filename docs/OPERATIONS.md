# Operations Playbook

Use this when the focus group poll is live.

> Before running any `UPDATE` or `DELETE`, preview the same `WHERE` clause with `SELECT *`. If the preview affects more rows than expected, stop.

## Common Operations

### Add a Respondent Group

```sql
insert into public.focus_groups (id, name, description, display_order)
values ('senior-leaders', 'Senior leaders', 'Leadership respondent group', 4);
```

### Rename a Group

```sql
update public.focus_groups
set name = 'Middle leaders',
    description = 'Heads of department and year-level leaders'
where id = 'group-b';
```

### Add a Time Option

```sql
insert into public.time_options (label, starts_at, ends_at, display_order)
values (
  'Thu 21 May 10:00am',
  '2026-05-21T10:00:00+12:00',
  '2026-05-21T10:30:00+12:00',
  31
);
```

The default schema already seeds 30-minute options for:

- Monday 18 May 2026, 11:00-12:00 and 13:00-15:00
- Tuesday 19 May 2026, 10:00-16:00
- Wednesday 20 May 2026, 10:00-16:00

### Hide a Time Option

Do this instead of deleting a time that already has responses.

```sql
update public.time_options
set active = false
where label = 'Option 2';
```

### Extend the Response Deadline

```sql
update public.settings
set value = '2026-05-17T23:59:59+12:00'
where key = 'response_cutoff_iso';
```

### Close Responses Immediately

```sql
update public.settings
set value = now()::text
where key = 'response_cutoff_iso';
```

### Add or Remove an Admin

```sql
insert into public.admins (email)
values ('helper@diocesan.school.nz');

delete from public.admins
where email = 'helper@diocesan.school.nz';
```

### See a Respondent's Saved Availability

```sql
select
  r.user_email,
  r.user_name,
  g.name as group_name,
  t.label,
  coalesce(a.status, 'unavailable') as status,
  t.starts_at,
  t.ends_at
from public.respondents r
join public.focus_groups g on g.id = r.group_id
cross join public.time_options t
left join public.availability a
  on a.user_id = r.user_id
 and a.time_option_id = t.id
where r.user_email = 'person@diocesan.school.nz'
  and t.active is true
order by t.starts_at;
```

### Manually Change a Respondent's Group

```sql
update public.respondents
set group_id = 'group-c',
    updated_at = now()
where user_email = 'person@diocesan.school.nz';
```

### Clear a Final Scheduled Time

```sql
update public.focus_groups
set final_time_option_id = null,
    final_location = null,
    final_note = null,
    finalised_at = null,
    finalised_by_email = null
where id = 'group-a';
```

## Admin Page

Open `/admin` to:

- View availability counts by group and time option
- See available, if-needed, and unavailable counts for each group
- See the strongest time for each group, ranked by available count first and if-needed count second
- Set the final time, location, and note
- Copy recipient emails and notification wording
- Download `.ics` calendar files and CSV exports

The app is static, so it cannot send email or attach files by itself. Use the admin page to generate the recipient list, message text, and `.ics` file, then send from your normal email client.

## Deployment Notes

- Vercel should deploy the `public` folder.
- Supabase URL and publishable key live in `public/config.js`.
- Keep the email domain in `public/config.js` aligned with `public.settings.email_domain`.
- Configure Google OAuth in Supabase Auth and add the callback URI:
  `https://<your-supabase-project>.supabase.co/auth/v1/callback`
- Add your deployed site URL and any local test URLs (for example `http://localhost:3000`) to Supabase Auth redirect URLs.
- The service-role key should never be committed or pasted into `config.js`.

## Reset

For a full reset, run:

```sql
-- supabase/drop_all.sql
-- then supabase/schema.sql
```

This deletes all responses and final scheduling decisions.
