-- Ensure every existing RidePicker user has the default driver preference row.
-- This is intentionally limited to driver_preferences and does not touch
-- WhatsApp sessions, auth state, jobs, messages, or connection lifecycle.
insert into public.driver_preferences (user_id)
select u.id
from public.users u
left join public.driver_preferences dp on dp.user_id = u.id
where dp.user_id is null
on conflict (user_id) do nothing;
