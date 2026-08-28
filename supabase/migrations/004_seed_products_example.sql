-- ============================================================
-- 004_seed_products_example.sql
--
-- DATOS DE EJEMPLO para poder probar el agente end-to-end.
-- Los precios NO son reales. Reemplazar por el catálogo real
-- de GreatPhones antes de usar en producción, o borrar todo con:
--
--   DELETE FROM product_variants;
--   DELETE FROM products;
--
-- Idempotente: se puede correr varias veces sin duplicar.
-- ============================================================

INSERT INTO products (categoria, marca, modelo, descripcion) VALUES
  ('smartphone', 'Apple', 'iPhone 13',      'iPhone 13 usado, revisado, con garantía'),
  ('smartphone', 'Apple', 'iPhone 14',      'iPhone 14 usado, revisado, con garantía'),
  ('smartphone', 'Apple', 'iPhone 15',      'iPhone 15 usado, revisado, con garantía'),
  ('smartphone', 'Apple', 'iPhone 15 Pro',  'iPhone 15 Pro usado, revisado, con garantía')
ON CONFLICT (marca, modelo) DO NOTHING;

-- Variantes: color × almacenamiento × precio × disponibilidad
INSERT INTO product_variants (product_id, color, almacenamiento, precio, availability_status, delivery_time_hours)
SELECT p.id, v.color, v.almacenamiento, v.precio, v.availability_status::availability_status, v.delivery_time_hours
FROM products p
JOIN (VALUES
  ('iPhone 13',     'Negro',           '128GB',  520000, 'AVAILABLE',      0),
  ('iPhone 13',     'Azul',            '256GB',  590000, 'AVAILABLE',     24),
  ('iPhone 14',     'Medianoche',      '128GB',  650000, 'AVAILABLE',      0),
  ('iPhone 14',     'Blanco Estrella', '256GB',  720000, 'AVAILABLE',     24),
  ('iPhone 15',     'Negro',           '128GB',  830000, 'AVAILABLE',      0),
  ('iPhone 15',     'Rosa',            '256GB',  910000, 'AVAILABLE',     48),
  ('iPhone 15 Pro', 'Titanio Natural', '256GB', 1150000, 'AVAILABLE',      0),
  ('iPhone 15 Pro', 'Titanio Negro',   '512GB', 1390000, 'NO_DISPONIBLE',  0)
) AS v(modelo, color, almacenamiento, precio, availability_status, delivery_time_hours)
  ON v.modelo = p.modelo
ON CONFLICT (product_id, color, almacenamiento) DO NOTHING;
