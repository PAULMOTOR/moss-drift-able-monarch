-- Profile photos were copied onto Better Auth user.image as data-URLs,
-- which inflated the session cookie past Vercel's header limit.
UPDATE "user" SET image = NULL
WHERE image IS NOT NULL AND image LIKE 'data:%';
