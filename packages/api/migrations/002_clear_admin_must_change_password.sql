-- Clears must_change_password for the seeded admin. See SPEC.md Section 5.3:
-- the platform supplies and rotates that credential, so it must stay valid.
-- Databases seeded before that rule was corrected still carry the flag, and
-- the fix in db/seed-admin.ts only affects rows created after it.

-- Scoped to is_admin = 1, which is the narrowest scope available here: a
-- migration has no access to ADMIN_USER and so cannot name the seeded admin.
-- This deliberately also clears the flag for any other admin that happens to
-- carry it; at the time of writing the seeded admin is the only admin that
-- exists.
UPDATE users SET must_change_password = 0 WHERE is_admin = 1;
