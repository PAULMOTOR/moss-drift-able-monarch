-- Inventory default owner is Lucas only when a lead is unassigned.
-- Never steal a file someone already owns. Restore Alex Hudon's deals.

DO $$
DECLARE
  alex_id text;
  lucas_id text;
  rid text;
BEGIN
  SELECT id INTO alex_id FROM profiles
   WHERE lower(email) = 'alexh@paulmotorcompany.com' AND active = true
   LIMIT 1;
  SELECT id INTO lucas_id FROM profiles
   WHERE lower(email) = 'lucasl@paulmotorcompany.com' AND active = true
   LIMIT 1;

  IF alex_id IS NULL THEN
    RETURN;
  END IF;

  FOR rid IN
    SELECT DISTINCT l.id
      FROM leads l
      LEFT JOIN inventory i ON i.id = l.inventory_id
     WHERE l.stage NOT IN ('won', 'lost')
       AND (
         lower(l.name) LIKE '%alain%hudon%'
         OR (
           lower(l.name) LIKE '%hakim%'
           AND (
             lower(coalesce(l.vehicle_interest, '')) LIKE '%bentayga%'
             OR lower(coalesce(l.vehicle_interest, '')) LIKE '%bentley%'
             OR lower(coalesce(i.model, '')) LIKE '%bentayga%'
             OR lower(coalesce(i.make, '')) LIKE '%bentley%'
           )
         )
         OR (
           lucas_id IS NOT NULL
           AND l.assigned_to = lucas_id
           AND l.created_by = alex_id
         )
       )
  LOOP
    UPDATE leads SET assigned_to = alex_id, updated_at = now() WHERE id = rid;
    INSERT INTO lead_activities (id, lead_id, kind, body, created_by_name)
    VALUES (
      gen_random_uuid()::text,
      rid,
      'system',
      'Assigned back to Alex Hudon. Inventory deals keep the salesperson who owns them — they are no longer moved to Lucas.',
      'CRM'
    );
  END LOOP;
END $$;
