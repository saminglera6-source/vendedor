/**
 * Sincronización del estado del agente con los pipelines y etapas de Kommo.
 *
 * Lee los IDs de pipeline y etapa desde variables de entorno para que el equipo
 * de GreatPhones pueda configurarlos sin tocar el código.
 *
 * Convención de nombres de variables:
 *   KOMMO_PIPELINE_{TIPO}_ID       — ID del pipeline
 *   KOMMO_STAGE_{TIPO}_{ETAPA}     — ID de la etapa dentro del pipeline
 *   KOMMO_FIELD_{CAMPO}_ID         — ID del campo personalizado
 */

import type { LeadEstado, AgentResponse } from '../../types.js';
import type { KommoTipoConsulta, KommoCustomFieldValue } from './types.js';
import type { Result } from '../../types.js';
import {
  updateLead,
  addNote,
  createTask,
  textField,
  numberField,
  boolField,
} from './client.js';
import { scoreToTemperatura } from './classifier.js';

// ===========================================================================
// Lectura de configuración de pipelines
// ===========================================================================

function envInt(key: string): number | null {
  const v = process.env[key];
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mapea LeadEstado + AccionVenta + TipoConsulta al pipeline y etapa de Kommo.
 * Retorna null si el tipo no tiene pipeline configurado o el estado no tiene mapping.
 */
export function mapToKommoStage(
  tipo: KommoTipoConsulta,
  estado: LeadEstado,
  accionVenta: AgentResponse['accion_venta'],
): { pipeline_id: number; status_id: number } | null {

  // ─── COMPRA ──────────────────────────────────────────────────────────────
  if (tipo === 'compra') {
    const pid = envInt('KOMMO_PIPELINE_COMPRA_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_COMPRA_NUEVO',
      CONSULTA: 'KOMMO_STAGE_COMPRA_NUEVO',
      INTERESADO: accionVenta === 'precio_dado'
        ? 'KOMMO_STAGE_COMPRA_PRESUPUESTO'
        : 'KOMMO_STAGE_COMPRA_CALIFICANDO',
      MUY_INTERESADO: 'KOMMO_STAGE_COMPRA_NEGOCIANDO',
      LISTO_PARA_COMPRAR: accionVenta === 'cierre_propuesto'
        ? 'KOMMO_STAGE_COMPRA_RESERVADO'
        : 'KOMMO_STAGE_COMPRA_NEGOCIANDO',
      CLIENTE: 'KOMMO_STAGE_COMPRA_VENDIDO',
      PERDIDO: 'KOMMO_STAGE_COMPRA_PERDIDO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  // ─── VENTA ───────────────────────────────────────────────────────────────
  if (tipo === 'venta') {
    const pid = envInt('KOMMO_PIPELINE_VENTA_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_VENTA_CONSULTA',
      CONSULTA: 'KOMMO_STAGE_VENTA_CONSULTA',
      INTERESADO: 'KOMMO_STAGE_VENTA_EVALUANDO',
      MUY_INTERESADO: 'KOMMO_STAGE_VENTA_COTIZACION',
      LISTO_PARA_COMPRAR: 'KOMMO_STAGE_VENTA_ACUERDO',
      CLIENTE: 'KOMMO_STAGE_VENTA_COMPLETADA',
      PERDIDO: 'KOMMO_STAGE_VENTA_PERDIDO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  // ─── PERMUTA ─────────────────────────────────────────────────────────────
  if (tipo === 'permuta') {
    const pid = envInt('KOMMO_PIPELINE_PERMUTA_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_PERMUTA_CONSULTA',
      CONSULTA: 'KOMMO_STAGE_PERMUTA_CONSULTA',
      INTERESADO: 'KOMMO_STAGE_PERMUTA_VALUACION',
      MUY_INTERESADO: 'KOMMO_STAGE_PERMUTA_PROPUESTA',
      LISTO_PARA_COMPRAR: 'KOMMO_STAGE_PERMUTA_ACUERDO',
      CLIENTE: 'KOMMO_STAGE_PERMUTA_REALIZADA',
      PERDIDO: 'KOMMO_STAGE_PERMUTA_PERDIDO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  // ─── REPARACIÓN ──────────────────────────────────────────────────────────
  if (tipo === 'reparacion') {
    const pid = envInt('KOMMO_PIPELINE_REPARACION_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_REPARACION_CONSULTA',
      CONSULTA: 'KOMMO_STAGE_REPARACION_CONSULTA',
      INTERESADO: 'KOMMO_STAGE_REPARACION_DIAGNOSTICO',
      MUY_INTERESADO: 'KOMMO_STAGE_REPARACION_PRESUPUESTO',
      LISTO_PARA_COMPRAR: 'KOMMO_STAGE_REPARACION_INGRESO',
      CLIENTE: 'KOMMO_STAGE_REPARACION_ENTREGADO',
      PERDIDO: 'KOMMO_STAGE_REPARACION_CANCELADO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  // ─── GARANTÍA ────────────────────────────────────────────────────────────
  if (tipo === 'garantia') {
    const pid = envInt('KOMMO_PIPELINE_GARANTIA_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_GARANTIA_RECLAMO',
      CONSULTA: 'KOMMO_STAGE_GARANTIA_RECLAMO',
      INTERESADO: 'KOMMO_STAGE_GARANTIA_VERIFICACION',
      MUY_INTERESADO: 'KOMMO_STAGE_GARANTIA_DIAGNOSTICO',
      LISTO_PARA_COMPRAR: 'KOMMO_STAGE_GARANTIA_RESOLUCION',
      CLIENTE: 'KOMMO_STAGE_GARANTIA_RESUELTO',
      PERDIDO: 'KOMMO_STAGE_GARANTIA_DENEGADO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  // ─── ACCESORIOS ──────────────────────────────────────────────────────────
  if (tipo === 'accesorios') {
    const pid = envInt('KOMMO_PIPELINE_ACCESORIOS_ID');
    if (!pid) return null;

    const stageMap: Partial<Record<LeadEstado, string>> = {
      NEW: 'KOMMO_STAGE_ACCESORIOS_CONSULTA',
      CONSULTA: 'KOMMO_STAGE_ACCESORIOS_CONSULTA',
      INTERESADO: 'KOMMO_STAGE_ACCESORIOS_PROPUESTA',
      MUY_INTERESADO: 'KOMMO_STAGE_ACCESORIOS_PROPUESTA',
      LISTO_PARA_COMPRAR: 'KOMMO_STAGE_ACCESORIOS_PROPUESTA',
      CLIENTE: 'KOMMO_STAGE_ACCESORIOS_VENDIDO',
      PERDIDO: 'KOMMO_STAGE_ACCESORIOS_PERDIDO',
    };

    const stageKey = stageMap[estado];
    const sid = stageKey ? envInt(stageKey) : null;
    if (!sid) return null;
    return { pipeline_id: pid, status_id: sid };
  }

  return null;
}

// ===========================================================================
// Construcción de campos personalizados
// ===========================================================================

function buildCustomFields(
  agentResponse: AgentResponse,
  tipo: KommoTipoConsulta,
  canal: string,
): KommoCustomFieldValue[] {
  const fields: KommoCustomFieldValue[] = [];

  const FIELD_SCORE = envInt('KOMMO_FIELD_SCORE_ID');
  const FIELD_TEMP = envInt('KOMMO_FIELD_TEMPERATURA_ID');
  const FIELD_TIPO = envInt('KOMMO_FIELD_TIPO_CONSULTA_ID');
  const FIELD_HUMANO = envInt('KOMMO_FIELD_REQUIERE_HUMANO_ID');
  const FIELD_INTENCION = envInt('KOMMO_FIELD_INTENCION_ID');
  const FIELD_CANAL = envInt('KOMMO_FIELD_CANAL_ENTRADA_ID');
  const FIELD_ACCION = envInt('KOMMO_FIELD_ACCION_VENTA_ID');

  if (FIELD_SCORE) fields.push(numberField(FIELD_SCORE, agentResponse.lead_score));
  if (FIELD_TEMP) fields.push(textField(FIELD_TEMP, scoreToTemperatura(agentResponse.lead_score)));
  if (FIELD_TIPO) fields.push(textField(FIELD_TIPO, tipo));
  if (FIELD_HUMANO) fields.push(boolField(FIELD_HUMANO, agentResponse.requiere_humano));
  if (FIELD_INTENCION) fields.push(textField(FIELD_INTENCION, agentResponse.intencion));
  if (FIELD_CANAL) fields.push(textField(FIELD_CANAL, canal));
  if (FIELD_ACCION) fields.push(textField(FIELD_ACCION, agentResponse.accion_venta));

  return fields;
}

// ===========================================================================
// Sincronización completa
// ===========================================================================

/**
 * Sincroniza el resultado del agente con Kommo:
 *  1. Mueve el lead a la etapa correcta del pipeline
 *  2. Actualiza todos los campos personalizados
 *  3. Crea tarea urgente si requiere_humano = true
 *  4. Crea tarea de seguimiento si hay followup programado
 *
 * Fire-and-forget desde el handler principal — no bloquea la respuesta al cliente.
 */
export async function syncToKommo(
  kommoLeadId: number,
  agentResponse: AgentResponse,
  tipo: KommoTipoConsulta,
  canal: string,
): Promise<Result<void>> {
  const stageData = mapToKommoStage(tipo, agentResponse.estado, agentResponse.accion_venta);
  const customFields = buildCustomFields(agentResponse, tipo, canal);

  // Actualizar pipeline + campos en una sola llamada
  const updateResult = await updateLead(kommoLeadId, {
    ...(stageData ?? {}),
    ...(customFields.length > 0 && { custom_fields_values: customFields }),
  });

  if (!updateResult.ok) {
    console.error('[kommo:sync] updateLead falló:', updateResult.error.message);
    // No retornar error — el mensaje ya fue enviado al cliente
  }

  // Tarea urgente de escalación
  if (agentResponse.requiere_humano) {
    const RESPONSIBLE = envInt('KOMMO_DEFAULT_RESPONSIBLE_USER_ID') ?? undefined;
    await createTask(
      kommoLeadId,
      `⚠️ ESCALACIÓN — Score: ${agentResponse.lead_score} — ${agentResponse.accion_venta} — Motivo: ${agentResponse.intencion}`,
      0.25, // 15 minutos
      RESPONSIBLE,
    ).catch((err: unknown) => {
      console.warn('[kommo:sync] createTask escalación falló:', err);
    });
  }

  // Tarea de seguimiento (si el agente programó un followup)
  if (agentResponse.followup) {
    const { tipo: tipoFollowup, delay_hours, mensaje_base } = agentResponse.followup;
    const RESPONSIBLE = envInt('KOMMO_DEFAULT_RESPONSIBLE_USER_ID') ?? undefined;
    await createTask(
      kommoLeadId,
      `📋 Follow-up [${tipoFollowup}]: ${mensaje_base}`,
      delay_hours,
      RESPONSIBLE,
    ).catch((err: unknown) => {
      console.warn('[kommo:sync] createTask followup falló:', err);
    });
  }

  // Nota interna con el resumen de la interacción
  const scoreEmoji = agentResponse.lead_score >= 70 ? '🔥' :
                     agentResponse.lead_score >= 40 ? '🟡' : '❄️';
  await addNote(
    kommoLeadId,
    `${scoreEmoji} Score: ${agentResponse.lead_score} | Estado: ${agentResponse.estado} | Acción: ${agentResponse.accion_venta} | Tipo: ${tipo}`,
  ).catch((err: unknown) => {
    console.warn('[kommo:sync] addNote falló:', err);
  });

  return { ok: true, value: undefined };
}
