-- Marketplace inventory belongs to Alex, not Lucas (and never get stolen back)
UPDATE leads
SET assigned_to = p_alex.id,
    updated_at = now()
FROM profiles p_alex
WHERE p_alex.active = true
  AND lower(p_alex.email) = 'alexh@paulmotorcompany.com'
  AND leads.lead_type = 'inventory'
  AND (
    lower(coalesce(leads.source, '')) = 'marketplace'
    OR lower(leads.name) LIKE 'frederick%'
  );
