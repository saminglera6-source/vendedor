/**
 * Análisis lingüístico y comercial de conversaciones reales de GreatPhones.
 * Procesa todos los message_1.json extraídos del ZIP de Instagram.
 *
 * Salida: JSON con estadísticas y ejemplos concretos para GREATPHONES_PERSONALITY_V1.
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// Config
// ============================================================

const INBOX_DIR = 'C:\\Users\\samin\\vendedor-ia\\_chat_analysis\\your_instagram_activity\\messages\\inbox';
const OUT_FILE   = 'C:\\Users\\samin\\vendedor-ia\\INSTAGRAM_ANALYSIS.json';

// El nombre de la cuenta GreatPhones en los exports puede variar; lo detectamos automáticamente
// buscando el sender que aparece más en mensajes tipo "outgoing"
// Típicamente el campo sender_name del dueño del inbox es consistente.
// Detectamos mirando quién envía la mayoría de los mensajes en cada hilo.

// ============================================================
// Utilidades de texto
// ============================================================

function decodeInstagram(str) {
  // Instagram exporta texto en latin1 escapado como UTF-8
  try {
    return decodeURIComponent(escape(str));
  } catch {
    return str;
  }
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // quitar acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ============================================================
// Cargar todos los hilos
// ============================================================

function loadAllThreads() {
  const threads = [];
  let dirs;
  try {
    dirs = readdirSync(INBOX_DIR);
  } catch {
    console.error('No se puede leer', INBOX_DIR);
    process.exit(1);
  }

  for (const dir of dirs) {
    const jsonPath = join(INBOX_DIR, dir, 'message_1.json');
    try {
      const raw = readFileSync(jsonPath, 'utf8');
      const data = JSON.parse(raw);
      threads.push(data);
    } catch {
      // skip
    }
  }
  return threads;
}

// ============================================================
// Detectar quién es GreatPhones (sender más frecuente)
// ============================================================

function detectSellerName(threads) {
  const freq = {};
  for (const t of threads) {
    for (const m of (t.messages || [])) {
      const name = decodeInstagram(m.sender_name || '');
      freq[name] = (freq[name] || 0) + 1;
    }
  }
  // El vendedor suele tener nombre distinto a todos los clientes
  // Típicamente es el dueño del inbox (nombre de la cuenta)
  // Buscamos el que tenga más mensajes
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  console.log('Top 5 senders:', sorted.slice(0, 5));
  return sorted[0][0]; // más frecuente = vendedor
}

// ============================================================
// Extraer mensajes del vendedor
// ============================================================

function extractSellerMessages(threads, sellerName) {
  const msgs = [];
  for (const t of threads) {
    for (const m of (t.messages || [])) {
      if (!m.content) continue;
      const name = decodeInstagram(m.sender_name || '');
      if (name === sellerName) {
        msgs.push({
          content: decodeInstagram(m.content),
          timestamp: m.timestamp_ms,
          thread: t.title || '',
        });
      }
    }
  }
  return msgs;
}

// ============================================================
// Análisis 1: Perfil general (frecuencias de patrones)
// ============================================================

function analyzeProfile(msgs) {
  const texts = msgs.map(m => m.content);

  // Signos de apertura
  const conApertura = texts.filter(t => t.includes('¿') || t.includes('¡')).length;
  // Tildes
  const conTildes = texts.filter(t => /[áéíóúüñ]/i.test(t)).length;
  // Emojis
  const conEmoji = texts.filter(t => /\p{Emoji}/u.test(t)).length;
  // Mayúsculas al inicio
  const conMayuscula = texts.filter(t => /^[A-ZÁÉÍÓÚ]/.test(t.trim())).length;
  // Palabras elongadas (holaaa, siii)
  const elongadas = texts.filter(t => /(.)\1{2,}/i.test(t)).length;
  // Abreviaciones comunes
  const abrevs = texts.filter(t => /\bq\b|\bxq\b|\bpq\b|\btmb\b|\btb\b|\bx\b|\bxfa\b/.test(normalize(t))).length;

  return {
    total_mensajes_vendedor: texts.length,
    con_signo_apertura_pct: pct(conApertura, texts.length),
    con_tildes_pct: pct(conTildes, texts.length),
    con_emoji_pct: pct(conEmoji, texts.length),
    inicia_mayuscula_pct: pct(conMayuscula, texts.length),
    palabras_elongadas_pct: pct(elongadas, texts.length),
    usa_abreviaturas_pct: pct(abrevs, texts.length),
  };
}

function pct(n, total) {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

// ============================================================
// Análisis 2: Longitud de mensajes
// ============================================================

function analyzeLength(msgs) {
  const lens = msgs.map(m => countWords(m.content));
  const total = lens.length;
  const avg = Math.round(lens.reduce((a, b) => a + b, 0) / total);
  const cortos  = lens.filter(l => l <= 5).length;
  const medios  = lens.filter(l => l > 5 && l <= 15).length;
  const largos  = lens.filter(l => l > 15).length;

  // Ejemplos por categoría
  const ejemplosCortos = msgs.filter(m => countWords(m.content) <= 5).slice(0, 10).map(m => m.content);
  const ejemplosMedios = msgs.filter(m => { const w = countWords(m.content); return w > 5 && w <= 15; }).slice(0, 10).map(m => m.content);
  const ejemplosLargos = msgs.filter(m => countWords(m.content) > 15).slice(0, 5).map(m => m.content);

  return {
    promedio_palabras: avg,
    cortos_1_5_palabras: { count: cortos, pct: pct(cortos, total) },
    medios_6_15_palabras: { count: medios, pct: pct(medios, total) },
    largos_mas_15_palabras: { count: largos, pct: pct(largos, total) },
    ejemplos_cortos: ejemplosCortos,
    ejemplos_medios: ejemplosMedios,
    ejemplos_largos: ejemplosLargos,
  };
}

// ============================================================
// Análisis 3: Vocabulario y frases frecuentes
// ============================================================

function analyzeVocabulary(msgs) {
  const wordFreq = {};
  const bigramFreq = {};
  const trigramFreq = {};

  for (const m of msgs) {
    const words = normalize(m.content).split(/\s+/).filter(w => w.length > 2);
    for (let i = 0; i < words.length; i++) {
      wordFreq[words[i]] = (wordFreq[words[i]] || 0) + 1;
      if (i < words.length - 1) {
        const bg = words[i] + ' ' + words[i+1];
        bigramFreq[bg] = (bigramFreq[bg] || 0) + 1;
      }
      if (i < words.length - 2) {
        const tg = words[i] + ' ' + words[i+1] + ' ' + words[i+2];
        trigramFreq[tg] = (trigramFreq[tg] || 0) + 1;
      }
    }
  }

  // Stop words a ignorar en el ranking
  const stopWords = new Set([
    'que', 'con', 'una', 'por', 'del', 'los', 'las', 'para', 'mas', 'pero',
    'como', 'son', 'hay', 'este', 'esta', 'ese', 'esa', 'ser', 'fue', 'era',
    'tiene', 'puedo', 'puede', 'cuando', 'donde', 'todo', 'todos', 'bien',
    'ver', 'hay', 'asi', 'aca', 'alla', 'ahora', 'antes', 'despues',
    'porque', 'sino', 'tampoco', 'tambien', 'tanto', 'nada', 'algo',
  ]);

  const topWords = Object.entries(wordFreq)
    .filter(([w]) => !stopWords.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([word, count]) => ({ word, count }));

  const topBigrams = Object.entries(bigramFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([phrase, count]) => ({ phrase, count }));

  const topTrigrams = Object.entries(trigramFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([phrase, count]) => ({ phrase, count }));

  return { topWords, topBigrams, topTrigrams };
}

// ============================================================
// Análisis 4: Patrones de escritura
// ============================================================

function analyzeWritingPatterns(msgs) {
  const texts = msgs.map(m => m.content);

  // Elongaciones tipo "siii", "holaaa", "daleee"
  const elongRegex = /\b\w*(.)\1{2,}\w*\b/gi;
  const elongExamples = [];
  for (const t of texts) {
    const matches = t.match(elongRegex);
    if (matches) elongExamples.push(...matches);
  }
  const elongFreq = {};
  for (const e of elongExamples) elongFreq[e.toLowerCase()] = (elongFreq[e.toLowerCase()] || 0) + 1;
  const topElongs = Object.entries(elongFreq).sort((a,b) => b[1]-a[1]).slice(0, 20);

  // Signos de apertura
  const sinApertura_preg = texts.filter(t => t.includes('?') && !t.includes('¿')).length;
  const conApertura_preg = texts.filter(t => t.includes('¿')).length;
  const sinApertura_exc  = texts.filter(t => t.includes('!') && !t.includes('¡')).length;
  const conApertura_exc  = texts.filter(t => t.includes('¡')).length;

  // Tildes: cuántas tienen alguna tilde vs no
  const conTildes = texts.filter(t => /[áéíóúüñ]/i.test(t)).length;
  const sinTildes = texts.filter(t => !/[áéíóúüñ]/i.test(t) && /[aeioun]/i.test(t)).length;

  // Mayúsculas al inicio
  const iniciaMayus = texts.filter(t => /^[A-ZÁÉÍÓÚ]/.test(t.trim())).length;
  const iniciaMinus = texts.filter(t => /^[a-záéíóú]/.test(t.trim())).length;

  // Abreviaciones
  const abrevExamples = texts.flatMap(t => {
    const matches = [];
    const abbrs = ['xfa','xq','pq','q','tb','tmb','bno','bnos','slds','ok','dale','sii','siiii'];
    for (const a of abbrs) {
      const re = new RegExp(`\\b${a}\\b`, 'i');
      if (re.test(t)) matches.push(a);
    }
    return matches;
  });
  const abrevFreq = {};
  for (const a of abrevExamples) abrevFreq[a] = (abrevFreq[a] || 0) + 1;

  return {
    signo_apertura_interrogacion: {
      con: conApertura_preg,
      sin: sinApertura_preg,
      pct_sin: pct(sinApertura_preg, sinApertura_preg + conApertura_preg)
    },
    signo_apertura_exclamacion: {
      con: conApertura_exc,
      sin: sinApertura_exc,
      pct_sin: pct(sinApertura_exc, sinApertura_exc + conApertura_exc)
    },
    tildes: {
      con_tildes: conTildes,
      sin_tildes: sinTildes,
      pct_usa_tildes: pct(conTildes, texts.length)
    },
    mayusculas_inicio: {
      inicia_mayuscula: iniciaMayus,
      inicia_minuscula: iniciaMinus,
      pct_mayuscula: pct(iniciaMayus, texts.length)
    },
    elongaciones_top: topElongs,
    abreviaciones: Object.entries(abrevFreq).sort((a,b)=>b[1]-a[1]),
  };
}

// ============================================================
// Análisis 5: Emojis
// ============================================================

function analyzeEmojis(msgs) {
  // Regex para capturar emojis (rango amplio)
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const emojiFreq = {};
  let totalMsgsConEmoji = 0;

  for (const m of msgs) {
    const found = m.content.match(emojiRegex);
    if (found) {
      totalMsgsConEmoji++;
      for (const e of found) {
        emojiFreq[e] = (emojiFreq[e] || 0) + 1;
      }
    }
  }

  const topEmojis = Object.entries(emojiFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([emoji, count]) => ({ emoji, count }));

  return {
    mensajes_con_emoji: totalMsgsConEmoji,
    pct_mensajes_con_emoji: pct(totalMsgsConEmoji, msgs.length),
    top_emojis: topEmojis,
  };
}

// ============================================================
// Análisis 6: Aperturas de conversación
// ============================================================

function analyzeOpenings(threads, sellerName) {
  // El "primer mensaje del vendedor" en cada hilo
  const openings = [];
  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse(); // orden cronológico
    const firstSeller = msgs.find(m => decodeInstagram(m.sender_name || '') === sellerName && m.content);
    if (firstSeller) {
      openings.push(decodeInstagram(firstSeller.content));
    }
  }

  const openingFreq = {};
  for (const o of openings) {
    const key = normalize(o).substring(0, 30);
    openingFreq[key] = (openingFreq[key] || 0) + 1;
  }

  return {
    total_hilos_con_apertura: openings.length,
    ejemplos: openings.slice(0, 30),
    patrones_frecuentes: Object.entries(openingFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([pattern, count]) => ({ pattern, count })),
  };
}

// ============================================================
// Análisis 7: Cierres de conversación
// ============================================================

function analyzeClosings(threads, sellerName) {
  const closings = [];
  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse(); // cronológico
    // Último mensaje del vendedor
    const lastSeller = [...msgs].reverse().find(m => decodeInstagram(m.sender_name || '') === sellerName && m.content);
    if (lastSeller) {
      closings.push(decodeInstagram(lastSeller.content));
    }
  }

  return {
    total_cierres: closings.length,
    ejemplos: closings.slice(0, 30),
  };
}

// ============================================================
// Análisis 8: Respuestas a consultas de precio
// ============================================================

function analyzePriceResponses(threads, sellerName) {
  const priceExchanges = [];

  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse(); // cronológico
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (!m.content) continue;
      const senderName = decodeInstagram(m.sender_name || '');
      // Mensaje del cliente preguntando precio
      if (senderName !== sellerName) {
        const text = normalize(decodeInstagram(m.content));
        if (/precio|cuesta|vale|cuanto|valor|precio/.test(text)) {
          // Buscar respuesta del vendedor
          for (let j = i + 1; j < Math.min(i + 4, msgs.length); j++) {
            const resp = msgs[j];
            if (!resp.content) continue;
            const respSender = decodeInstagram(resp.sender_name || '');
            if (respSender === sellerName) {
              priceExchanges.push({
                pregunta: decodeInstagram(m.content),
                respuesta: decodeInstagram(resp.content),
              });
              break;
            }
          }
        }
      }
    }
  }

  return {
    total_intercambios_precio: priceExchanges.length,
    ejemplos: priceExchanges.slice(0, 20),
  };
}

// ============================================================
// Análisis 9: Manejo de objeciones
// ============================================================

function analyzeObjections(threads, sellerName) {
  const objections = {
    precio_alto: [],
    lo_pienso: [],
    otra_oferta: [],
    no_alcanza: [],
    ver_despues: [],
  };

  const patterns = {
    precio_alto: /caro|cara|mucho|caros|caras|no llego|no tengo tanto|mas barato|mas economico/,
    lo_pienso: /lo pienso|me lo pienso|pensar|veo|lo veo|despues|despues te|lo comento|lo consulto/,
    otra_oferta: /vi en|vi que|en otra|me ofrecieron|otro lado|mercado libre|meli|facebook|otra parte|mas barato en/,
    no_alcanza: /no tengo|no llego|no me alcanza|presupuesto|poco|justo/,
    ver_despues: /despues|mas adelante|otro dia|la semana|el mes|lo veo|por ahora no/,
  };

  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse();
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (!m.content) continue;
      const senderName = decodeInstagram(m.sender_name || '');
      if (senderName !== sellerName) {
        const text = normalize(decodeInstagram(m.content));
        for (const [type, pattern] of Object.entries(patterns)) {
          if (pattern.test(text)) {
            for (let j = i + 1; j < Math.min(i + 4, msgs.length); j++) {
              const resp = msgs[j];
              if (!resp.content) continue;
              const respSender = decodeInstagram(resp.sender_name || '');
              if (respSender === sellerName) {
                objections[type].push({
                  objecion: decodeInstagram(m.content),
                  respuesta: decodeInstagram(resp.content),
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(objections).map(([k, v]) => [k, {
      total: v.length,
      ejemplos: v.slice(0, 8),
    }])
  );
}

// ============================================================
// Análisis 10-12: Garantía, Reparaciones, Canje
// ============================================================

function analyzeSpecialTopics(threads, sellerName) {
  const topics = {
    garantia: { keywords: /garantia|garantía|garantías|falla|defecto|roto|no funciona/, examples: [] },
    reparacion: { keywords: /repar|arregl|pantalla|bateria|batería|cargador|chip|tecnico|técnico|presupuesto/, examples: [] },
    canje: { keywords: /canje|permuta|cambio|cambia|entrego|parte de pago|usado|mio|el que tengo/, examples: [] },
  };

  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse();
    for (let i = 0; i < msgs.length - 1; i++) {
      const m = msgs[i];
      if (!m.content) continue;
      const senderName = decodeInstagram(m.sender_name || '');
      if (senderName !== sellerName) {
        const text = normalize(decodeInstagram(m.content));
        for (const [topic, cfg] of Object.entries(topics)) {
          if (cfg.keywords.test(text)) {
            for (let j = i + 1; j < Math.min(i + 4, msgs.length); j++) {
              const resp = msgs[j];
              if (!resp.content) continue;
              const respSender = decodeInstagram(resp.sender_name || '');
              if (respSender === sellerName) {
                cfg.examples.push({
                  consulta: decodeInstagram(m.content),
                  respuesta: decodeInstagram(resp.content),
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(topics).map(([k, v]) => [k, {
      total: v.examples.length,
      ejemplos: v.examples.slice(0, 15),
    }])
  );
}

// ============================================================
// Análisis 13-14: Ventas exitosas y fallidas
// ============================================================

function analyzeSalesOutcomes(threads, sellerName) {
  const exitosas = [];
  const fallidas = [];

  const exitoKeywords = /listo|lo tomo|lo llevamos|lo llevo|compro|compramos|lo quiero|cerramos|acordamos|te transfiero|te pago|envio la seña|quedo|reservame|reservo|cuánto y lo cierro/;
  const failKeywords = /gracias igual|no gracias|dejalo|lo dejo|no por ahora|al final no|lo compre en|compre otro|lo consegui|ya lo compre|me lo quede|no me interesa|en otro lado/;

  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse();
    const allTexts = msgs.map(m => m.content ? normalize(decodeInstagram(m.content)) : '').join(' ');

    const sellerMsgs = msgs.filter(m => decodeInstagram(m.sender_name || '') === sellerName && m.content);
    const clientMsgs = msgs.filter(m => decodeInstagram(m.sender_name || '') !== sellerName && m.content);

    if (exitoKeywords.test(allTexts)) {
      exitosas.push({
        thread: t.title || '',
        mensaje_count: msgs.length,
        ultimos_mensajes: msgs.slice(-4).map(m => ({
          sender: decodeInstagram(m.sender_name || ''),
          content: decodeInstagram(m.content || ''),
        })),
      });
    } else if (failKeywords.test(allTexts)) {
      fallidas.push({
        thread: t.title || '',
        mensaje_count: msgs.length,
        ultimos_mensajes: msgs.slice(-4).map(m => ({
          sender: decodeInstagram(m.sender_name || ''),
          content: decodeInstagram(m.content || ''),
        })),
      });
    }
  }

  return {
    exitosas: { count: exitosas.length, ejemplos: exitosas.slice(0, 10) },
    fallidas: { count: fallidas.length, ejemplos: fallidas.slice(0, 10) },
  };
}

// ============================================================
// Análisis adicional: mensajes consecutivos del vendedor
// ============================================================

function analyzeConsecutiveMessages(threads, sellerName) {
  let totalConsecutiveGroups = 0;
  let totalLoneMessages = 0;
  const groupSizes = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };

  for (const t of threads) {
    const msgs = (t.messages || []).slice().reverse();
    let streak = 0;
    let prevSender = null;

    for (const m of msgs) {
      const sender = decodeInstagram(m.sender_name || '');
      if (sender === sellerName && m.content) {
        streak++;
      } else {
        if (prevSender === sellerName && streak > 0) {
          if (streak === 1) groupSizes[1]++;
          else if (streak === 2) groupSizes[2]++;
          else if (streak === 3) groupSizes[3]++;
          else if (streak === 4) groupSizes[4]++;
          else groupSizes['5+']++;
          if (streak > 1) totalConsecutiveGroups++;
        }
        streak = 0;
      }
      prevSender = sender;
    }
  }

  return { groupSizes, totalConsecutiveGroups };
}

// ============================================================
// Análisis: saludos y palabras de apertura frecuentes
// ============================================================

function analyzeGreetings(msgs) {
  const greetings = ['hola', 'buenas', 'buen dia', 'buen dia', 'buenas tardes', 'buenos dias', 'que tal', 'como va', 'como estas'];
  const freq = {};
  for (const g of greetings) freq[g] = 0;

  for (const m of msgs) {
    const t = normalize(m.content);
    for (const g of greetings) {
      if (t.startsWith(g) || t.includes(g)) {
        freq[g]++;
      }
    }
  }
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]);
}

// ============================================================
// Main
// ============================================================

console.log('Cargando hilos...');
const threads = loadAllThreads();
console.log(`Total hilos: ${threads.length}`);

const sellerName = detectSellerName(threads);
console.log(`Vendedor detectado: "${sellerName}"`);

const sellerMsgs = extractSellerMessages(threads, sellerName);
console.log(`Mensajes del vendedor: ${sellerMsgs.length}`);

console.log('Analizando...');

const analysis = {
  meta: {
    seller_name: sellerName,
    total_threads: threads.length,
    total_seller_messages: sellerMsgs.length,
    analyzed_at: new Date().toISOString(),
  },
  perfil_general: analyzeProfile(sellerMsgs),
  longitud_mensajes: analyzeLength(sellerMsgs),
  vocabulario: analyzeVocabulary(sellerMsgs),
  patrones_escritura: analyzeWritingPatterns(sellerMsgs),
  emojis: analyzeEmojis(sellerMsgs),
  aperturas: analyzeOpenings(threads, sellerName),
  cierres: analyzeClosings(threads, sellerName),
  respuestas_precio: analyzePriceResponses(threads, sellerName),
  objeciones: analyzeObjections(threads, sellerName),
  temas_especiales: analyzeSpecialTopics(threads, sellerName),
  resultados_venta: analyzeSalesOutcomes(threads, sellerName),
  mensajes_consecutivos: analyzeConsecutiveMessages(threads, sellerName),
  saludos: analyzeGreetings(sellerMsgs),
};

writeFileSync(OUT_FILE, JSON.stringify(analysis, null, 2), 'utf8');
console.log(`\nAnálisis guardado en: ${OUT_FILE}`);
console.log(`\n=== RESUMEN RÁPIDO ===`);
console.log(`Mensajes analizados: ${sellerMsgs.length}`);
console.log(`Promedio palabras/msg: ${analysis.longitud_mensajes.promedio_palabras}`);
console.log(`% con emoji: ${analysis.perfil_general.con_emoji_pct}%`);
console.log(`% con signo ¿: ${analysis.perfil_general.con_signo_apertura_pct}%`);
console.log(`% con tildes: ${analysis.perfil_general.con_tildes_pct}%`);
console.log(`% inicia mayúscula: ${analysis.perfil_general.inicia_mayuscula_pct}%`);
console.log(`\nTop 20 palabras:`);
analysis.vocabulario.topWords.slice(0, 20).forEach(w => console.log(`  ${w.word}: ${w.count}`));
console.log(`\nTop emojis:`);
analysis.emojis.top_emojis.slice(0, 10).forEach(e => console.log(`  ${e.emoji}: ${e.count}`));
