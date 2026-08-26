-- Link RidePicker application users to verified Supabase Auth subjects.
-- Applied to the RidePicker production Supabase project on 2026-08-23.

alter table public.users
  add constraint users_auth_user_id_fkey
  foreign key (auth_user_id)
  references auth.users(id)
  on delete set null;
