/**
 * Acceso a datos de productos y variantes.
 *
 * INVARIANTE DE SEGURIDAD:
 * `supply_notes` NUNCA se selecciona en este módulo.
 * Es un campo interno del negocio (origen del stock) que no debe
 * circular por la aplicación ni llegar al agente o al cliente.
 *
 * Toda query que involucre product_variants usa VARIANT_SAFE_SELECT.
 */

import { db, assertOne, assertDataOrNull, assertData } from './client.js';
import {
  ok,
  err,
  DatabaseError,
  type Product,
  type ProductVariantPublic,
  type ProductVariantWithProduct,
  type Result,
} from '../types.js';

// ---------------------------------------------------------------------------
// Columnas seguras para variantes — supply_notes excluido intencionalmente
// ---------------------------------------------------------------------------

/**
 * Selector de columnas de product_variants que es seguro exponer.
 * Usado en todas las queries de este módulo.
 */
const VARIANT_SAFE_SELECT = `
  id,
  product_id,
  color,
  almacenamiento,
  precio,
  availability_status,
  delivery_time_hours,
  activo,
  created_at,
  updated_at
` as const;

/**
 * Selector con join a products para devolver ProductVariantWithProduct.
 * El campo `product` viene del join por FK product_id → products.id.
 */
const VARIANT_WITH_PRODUCT_SELECT = `
  id,
  product_id,
  color,
  almacenamiento,
  precio,
  availability_status,
  delivery_time_hours,
  activo,
  created_at,
  updated_at,
  product:products ( marca, modelo, categoria, descripcion, imagen_url )
` as const;

// ---------------------------------------------------------------------------
// Tipo interno del resultado del join (Supabase no infiere joins automáticamente)
// ---------------------------------------------------------------------------

type VariantJoinRow = ProductVariantPublic & {
  product: {
    marca: string;
    modelo: string;
    categoria: string;
    descripcion: string | null;
    imagen_url: string | null;
  } | null;
};

/** Normaliza el resultado del join al tipo de dominio ProductVariantWithProduct */
function toVariantWithProduct(row: VariantJoinRow): ProductVariantWithProduct | null {
  if (!row.product) return null;
  return {
    ...row,
    product: row.product,
  };
}

// ---------------------------------------------------------------------------
// getProduct
// ---------------------------------------------------------------------------

/** Devuelve un producto por ID, o null si no existe. */
export async function getProduct(
  productId: string,
): Promise<Result<Product | null>> {
  try {
    const product = assertDataOrNull(
      await db
        .from('products')
        .select('*')
        .eq('id', productId)
        .maybeSingle(),
    );

    return ok(product);
  } catch (error) {
    return toDbError(error, 'getProduct');
  }
}

// ---------------------------------------------------------------------------
// getVariant
// ---------------------------------------------------------------------------

/**
 * Devuelve una variante por ID sin `supply_notes`.
 * Útil cuando el agente tiene el variant_id de una conversación anterior.
 */
export async function getVariant(
  variantId: string,
): Promise<Result<ProductVariantPublic | null>> {
  try {
    const variant = assertDataOrNull(
      await db
        .from('product_variants')
        .select(VARIANT_SAFE_SELECT)
        .eq('id', variantId)
        .maybeSingle(),
    );

    return ok(variant as ProductVariantPublic | null);
  } catch (error) {
    return toDbError(error, 'getVariant');
  }
}

// ---------------------------------------------------------------------------
// searchProducts
// ---------------------------------------------------------------------------

export interface SearchProductsOptions {
  /** Texto libre: busca en marca y modelo del producto */
  query: string;
  /** Si true, solo devuelve variantes AVAILABLE. Default: false */
  availableOnly?: boolean;
  /** Máximo de resultados. Default: 20 */
  limit?: number;
}

/**
 * Busca productos por texto libre en marca y modelo.
 * Devuelve todas las variantes activas de los productos encontrados.
 *
 * Para búsquedas más precisas por color/almacenamiento usar
 * `getProductByModelAndStorage`.
 */
export async function searchProducts(
  opts: SearchProductsOptions,
): Promise<Result<ProductVariantWithProduct[]>> {
  const { query, availableOnly = false, limit = 20 } = opts;

  try {
    const term = `%${query.trim()}%`;

    // Buscar IDs de productos que coinciden con el texto
    const matchingProducts = assertData(
      await db
        .from('products')
        .select('id')
        .or(`marca.ilike.${term},modelo.ilike.${term}`)
        .eq('activo', true),
    );

    if (matchingProducts.length === 0) return ok([]);

    const productIds = matchingProducts.map((p) => p.id);

    // Obtener variantes de esos productos
    let variantsQuery = db
      .from('product_variants')
      .select(VARIANT_WITH_PRODUCT_SELECT)
      .in('product_id', productIds)
      .eq('activo', true)
      .order('precio', { ascending: true })
      .limit(limit);

    if (availableOnly) {
      variantsQuery = variantsQuery.eq('availability_status', 'AVAILABLE');
    }

    const rows = assertData(await variantsQuery) as VariantJoinRow[];

    const variants = rows
      .map(toVariantWithProduct)
      .filter((v): v is ProductVariantWithProduct => v !== null);

    return ok(variants);
  } catch (error) {
    return toDbError(error, 'searchProducts');
  }
}

// ---------------------------------------------------------------------------
// getAvailableProducts
// ---------------------------------------------------------------------------

export interface GetAvailableProductsFilters {
  categoria?: string;
  marca?: string;
  /** Máximo de resultados. Default: 50 */
  limit?: number;
}

/**
 * Devuelve todas las variantes disponibles (availability_status = 'AVAILABLE').
 * Útil para mostrar catálogo completo o para el sistema RAG.
 *
 * Ordenadas por delivery_time_hours ASC (primero las de entrega más rápida)
 * y luego precio ASC.
 */
export async function getAvailableProducts(
  filters: GetAvailableProductsFilters = {},
): Promise<Result<ProductVariantWithProduct[]>> {
  const { categoria, marca, limit = 50 } = filters;

  try {
    // Resolver IDs de productos si hay filtros de catalog
    let productIds: string[] | null = null;

    if (categoria !== undefined || marca !== undefined) {
      let productQuery = db
        .from('products')
        .select('id')
        .eq('activo', true);

      if (categoria !== undefined) {
        productQuery = productQuery.eq('categoria', categoria);
      }
      if (marca !== undefined) {
        productQuery = productQuery.ilike('marca', `%${marca}%`);
      }

      const products = assertData(await productQuery);
      productIds = products.map((p) => p.id);

      if (productIds.length === 0) return ok([]);
    }

    let variantsQuery = db
      .from('product_variants')
      .select(VARIANT_WITH_PRODUCT_SELECT)
      .eq('availability_status', 'AVAILABLE')
      .eq('activo', true)
      .order('delivery_time_hours', { ascending: true })
      .order('precio', { ascending: true })
      .limit(limit);

    if (productIds !== null) {
      variantsQuery = variantsQuery.in('product_id', productIds);
    }

    const rows = assertData(await variantsQuery) as VariantJoinRow[];

    const variants = rows
      .map(toVariantWithProduct)
      .filter((v): v is ProductVariantWithProduct => v !== null);

    return ok(variants);
  } catch (error) {
    return toDbError(error, 'getAvailableProducts');
  }
}

// ---------------------------------------------------------------------------
// getProductByModelAndStorage
// ---------------------------------------------------------------------------

export interface GetByModelOptions {
  /** Modelo del producto (búsqueda parcial, ej: "iPhone 15" o "15 pro") */
  modelo: string;
  /** Almacenamiento exacto, ej: "256GB". Si undefined, devuelve todos. */
  almacenamiento?: string;
  /** Color parcial, ej: "negro". Si undefined, devuelve todos. */
  color?: string;
  /** Si true, solo devuelve AVAILABLE. Default: true */
  availableOnly?: boolean;
}

/**
 * Busca variantes para el agente cuando tiene datos de customer_memory.
 *
 * Ejemplo de uso:
 *   customer_memory = { producto_interes: "iPhone 15 Pro", almacenamiento: "256GB", color_preferido: "negro" }
 *   → getProductByModelAndStorage({ modelo: "iPhone 15 Pro", almacenamiento: "256GB", color: "negro" })
 *
 * Devuelve variantes ordenadas por delivery_time_hours ASC (entrega más rápida primero).
 */
export async function getProductByModelAndStorage(
  opts: GetByModelOptions,
): Promise<Result<ProductVariantWithProduct[]>> {
  const {
    modelo,
    almacenamiento,
    color,
    availableOnly = true,
  } = opts;

  try {
    // Encontrar productos que coincidan con el modelo
    const matchingProducts = assertData(
      await db
        .from('products')
        .select('id')
        .ilike('modelo', `%${modelo.trim()}%`)
        .eq('activo', true),
    );

    if (matchingProducts.length === 0) return ok([]);

    const productIds = matchingProducts.map((p) => p.id);

    let variantsQuery = db
      .from('product_variants')
      .select(VARIANT_WITH_PRODUCT_SELECT)
      .in('product_id', productIds)
      .eq('activo', true)
      .order('delivery_time_hours', { ascending: true })
      .order('precio', { ascending: true });

    if (availableOnly) {
      variantsQuery = variantsQuery.eq('availability_status', 'AVAILABLE');
    }
    if (almacenamiento !== undefined) {
      variantsQuery = variantsQuery.eq('almacenamiento', almacenamiento);
    }
    if (color !== undefined) {
      variantsQuery = variantsQuery.ilike('color', `%${color.trim()}%`);
    }

    const rows = assertData(await variantsQuery) as VariantJoinRow[];

    const variants = rows
      .map(toVariantWithProduct)
      .filter((v): v is ProductVariantWithProduct => v !== null);

    return ok(variants);
  } catch (error) {
    return toDbError(error, 'getProductByModelAndStorage');
  }
}

// ---------------------------------------------------------------------------
// getVariantsByProductId (helper para mostrar todas las opciones de un modelo)
// ---------------------------------------------------------------------------

/**
 * Devuelve todas las variantes disponibles de un producto específico.
 * Útil para presentar opciones al cliente ("tenemos el iPhone 15 Pro en...").
 */
export async function getVariantsByProductId(
  productId: string,
  availableOnly = true,
): Promise<Result<ProductVariantWithProduct[]>> {
  try {
    let query = db
      .from('product_variants')
      .select(VARIANT_WITH_PRODUCT_SELECT)
      .eq('product_id', productId)
      .eq('activo', true)
      .order('delivery_time_hours', { ascending: true })
      .order('almacenamiento', { ascending: true })
      .order('precio', { ascending: true });

    if (availableOnly) {
      query = query.eq('availability_status', 'AVAILABLE');
    }

    const rows = assertData(await query) as VariantJoinRow[];

    const variants = rows
      .map(toVariantWithProduct)
      .filter((v): v is ProductVariantWithProduct => v !== null);

    return ok(variants);
  } catch (error) {
    return toDbError(error, 'getVariantsByProductId');
  }
}

// ---------------------------------------------------------------------------
// Helper interno
// ---------------------------------------------------------------------------

function toDbError(error: unknown, context: string): Result<never> {
  if (error instanceof DatabaseError) return err(error);
  return err(
    new DatabaseError(
      `Error en products.${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: String(error) },
    ),
  );
}
