-- Assign all inventory leads to Lucas Legatos (default inventory owner)
UPDATE leads
SET assigned_to = p.id,
    updated_at = now()
FROM profiles p
WHERE leads.lead_type = 'inventory'
  AND p.active = true
  AND (
    lower(p.email) = 'lucasl@paulmotorcompany.com'
    OR lower(p.name) LIKE 'lucas%'
  )
  AND (leads.assigned_to IS DISTINCT FROM p.id)
  AND p.id = (
    SELECT id FROM profiles
    WHERE active = true
      AND (
        lower(email) = 'lucasl@paulmotorcompany.com'
        OR lower(name) LIKE 'lucas%'
      )
    ORDER BY CASE WHEN lower(email) = 'lucasl@paulmotorcompany.com' THEN 0 ELSE 1 END
    LIMIT 1
  );
