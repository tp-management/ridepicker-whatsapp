-- The first lifecycle dedupe trigger used BEFORE INSERT + RETURN NULL to
-- suppress transport-only duplicate Activity rows. That correctly kept the
-- user-facing timeline clean, but PostgREST then returned no inserted row and
-- repository.addActivity() treated that as an error.
--
-- Keep the same semantic dedupe, but run it AFTER INSERT. The original INSERT
-- can still return its representation to the backend while the duplicate row
-- is removed inside the same transaction before commit.

create or replace function public.ridepicker_activity_whatsapp_lifecycle_dedupe()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous_title text;
begin
  if new.type <> 'whatsapp'
     or new.title not in ('WhatsApp connected', 'WhatsApp disconnected') then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ridepicker:activity:whatsapp:' || new.user_id::text, 0)
  );

  select a.title
    into v_previous_title
  from public.activity a
  where a.user_id = new.user_id
    and a.type = 'whatsapp'
    and a.title in ('WhatsApp connected', 'WhatsApp disconnected')
    and a.id <> new.id
  order by a.created_at desc, a.id desc
  limit 1;

  if v_previous_title = new.title then
    delete from public.activity
    where id = new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.ridepicker_activity_whatsapp_lifecycle_dedupe()
  from public, anon, authenticated;

drop trigger if exists activity_whatsapp_lifecycle_dedupe
  on public.activity;

create trigger activity_whatsapp_lifecycle_dedupe
after insert on public.activity
for each row
execute function public.ridepicker_activity_whatsapp_lifecycle_dedupe();
