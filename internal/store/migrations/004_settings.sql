-- Site-wide settings changed from the admin page, as key → value.
-- maintenance = 'on' closes the site to everyone but admins.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
