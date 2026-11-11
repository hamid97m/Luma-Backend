-- Whether the bot can reach the user in Telegram. NULL = not known yet.
--   active      — started the bot / a bot message was delivered / unblocked it
--   blocked     — blocked or stopped the bot (my_chat_member 'kicked' or a 403 "blocked by the user")
--   deactivated — deleted their Telegram account (403 "user is deactivated")
--   not_started — never pressed Start and didn't allow bot DMs (403 "can't initiate conversation")
ALTER TABLE users
  ADD COLUMN bot_status text CHECK (bot_status IN ('active', 'blocked', 'deactivated', 'not_started')),
  ADD COLUMN bot_status_at timestamptz;
