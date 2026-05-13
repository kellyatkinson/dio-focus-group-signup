# Focus Group Scheduler

A lightweight internal availability poll for scheduling focus group sessions.

Respondents sign in with Google, choose their respondent group, and mark each time as available, if needed, or unavailable. Admins can then see the counts by group, choose the final time for each group, copy notification text, export recipient CSVs, and download `.ics` calendar files.

All groups see the same open set of candidate times. The admin can choose a different final time for each group.

## Stack

- **Frontend:** static HTML/CSS/JS, no build step
- **Backend:** Supabase Auth, Postgres, RLS, and RPC functions
- **Hosting:** Vercel or any static host
- **Auth:** Google OAuth via Supabase, with an allowed email domain

## Project Structure

```text
focus-group-signup/
|-- public/
|   |-- index.html        # respondent availability form
|   |-- app.js            # respondent logic
|   |-- admin.html        # admin scheduling view
|   |-- admin.js          # admin logic, exports, .ics generation
|   |-- styles.css        # shared styling
|   `-- config.js         # public Supabase config + UI defaults
|-- supabase/
|   |-- schema.sql        # full schema, seed data, RLS, RPCs
|   `-- drop_all.sql      # clean-slate reset
|-- docs/
|   `-- OPERATIONS.md     # admin playbook
`-- .github/workflows/
    `-- keep-warm.yml
```

## Setup Checklist

1. Create or reuse a Supabase project.
2. Copy `.env.example` to `.env` and update with your Supabase URL, publishable key, organisation name, and email domain.
3. Run `npm run build-config` to generate `public/config.js` from your environment variables.
4. In Supabase SQL Editor, run `supabase/drop_all.sql` if you are replacing the original booking tool, then run `supabase/schema.sql`.
5. In `supabase/schema.sql`, replace the seed rows in `focus_groups`, `settings`, and `admins`. The included `time_options` seed covers 30-minute slots on Monday 18 May, Tuesday 19 May, and Wednesday 20 May 2026.
7. Configure Google OAuth in Supabase Authentication:
   - In the Supabase dashboard, go to **Authentication > Providers** and enable **Google**.
   - Create Google OAuth credentials in the Google Cloud Console if you do not already have them.
   - Add this callback URI to the Google OAuth client:
     `https://<your-supabase-project>.supabase.co/auth/v1/callback`
   - In Supabase **Auth > Settings**, set your site URL to the deployed app URL and add redirect URLs for your deployed site and any local test URLs such as `http://localhost:3000`.
   - Since the app uses `redirectTo: window.location.origin`, the final redirect after sign-in returns to the current app origin.
7. Deploy the `public` folder to Vercel. Use the **Other** framework preset and set the root directory to `public`.
8. In Supabase Authentication URL Configuration, set the deployed site URL and add local redirect URLs if needed.
9. For Vercel deployments, ensure you set the environment variables in Vercel's dashboard, then run `npm run build-config` during your build command (or manually before deploying).

## Testing Without a Local Server

If your organisation blocks local web servers, use a hosted preview instead:

1. Push this repo to GitHub.
2. Import it into Vercel with the root directory set to `public`.
3. Use the Vercel preview URL for testing.
4. Add the preview URL to Supabase Authentication redirect URLs.

For example:

```text
https://your-preview-url.vercel.app/**
```

## Admin Workflow

1. Respondents submit availability at `/`.
2. Admins open `/admin`.
3. For each group, the admin page highlights the time with the most available respondents.
4. Enter the location and optional note, then click **Set as final**.
5. Use the notification tools for that group:
   - Copy emails
   - Copy message
   - Download `.ics`
   - Download recipient CSV
   - Open an email draft

Static sites cannot attach files to an email automatically, so the email draft button creates the message body and recipients; attach the downloaded `.ics` file before sending.

## Database Model

- `focus_groups`: respondent groups plus the final selected time/location
- `time_options`: candidate times shown to every respondent
- `respondents`: one row per signed-in respondent
- `availability`: the respondent's available and if-needed time options. Missing rows mean unavailable after they submit.
- `admins`: emails allowed to use `/admin`
- `settings`: app title, organisation name, email domain, response cutoff

Writes go through RPC functions so RLS can keep respondents limited to their own response while admins can see aggregate and recipient data.
