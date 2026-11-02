-- Real-time chat: every insert/update/delete on messages announces itself on
-- the 'luma_chat' channel. The backend LISTENs (src/realtime/listener.ts) and
-- pushes the change to connected participants over SSE (GET /events).
--
-- Payload is ids only (NOTIFY caps at 8000 bytes; bodies never go here):
--   {"op":"INSERT|UPDATE|DELETE","id":"<message id>","matchId":"<uuid>","u1":"<user1_id>","u2":"<user2_id>"}
-- u1/u2 let the backend skip work when neither participant is connected.

create or replace function notify_chat_message()
  returns trigger
  language plpgsql
as $function$
  declare
    msg_id uuid;
    msg_match_id uuid;
    p1 uuid;
    p2 uuid;
  begin
    if tg_op = 'DELETE' then
      msg_id := old.id;
      msg_match_id := old.match_id;
    else
      -- An UPDATE that changed nothing is not news.
      if tg_op = 'UPDATE' and old is not distinct from new then
        return null;
      end if;
      msg_id := new.id;
      msg_match_id := new.match_id;
    end if;

    select user1_id, user2_id into p1, p2 from matches where id = msg_match_id;
    -- Match gone (messages cascading from a match delete): nobody to tell.
    if not found then
      return null;
    end if;

    perform pg_notify('luma_chat', json_build_object(
      'op', tg_op, 'id', msg_id, 'matchId', msg_match_id, 'u1', p1, 'u2', p2
    )::text);
    return null;
  end;
$function$;

drop trigger if exists trg_messages_notify on messages;
create trigger trg_messages_notify
  after insert or update or delete on messages
  for each row execute function notify_chat_message();
