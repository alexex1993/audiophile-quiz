-- Guests: players without a Google account, known only by their session
-- cookie; they may play the warm-up (easy) level. A guest has google_sub NULL
-- and email ''. Signing in with Google moves a guest's finished attempts to
-- the Google user and deletes the guest.
ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;
