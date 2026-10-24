-- Difficulty = AAC bitrate of the compressed clips: easy 64k, medium 128k, hard 320k.
-- Earlier attempts were all played at 128k.
ALTER TABLE attempts ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard'));
ALTER TABLE attempts ALTER COLUMN difficulty DROP DEFAULT;

-- Tracks processed before this have only a 128k clip (encoded.flac or .wav)
-- and can't serve the other levels; they have to be uploaded again.
UPDATE tracks SET active = false;
