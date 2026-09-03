/**
 * Simulador de conversación tipo WhatsApp para probar el agente en el navegador.
 *
 * Herramienta de desarrollo. Se sirve en GET / y GET /chat desde el mismo
 * servidor, así que no hay problema de CORS. No usar en producción.
 */

export const CHAT_SIM_HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vendedor-ia · simulador WhatsApp</title>
<style>
  :root { --wa-bg:#0b141a; --wa-panel:#111b21; --wa-out:#005c4b; --wa-in:#202c33; --wa-text:#e9edef; --wa-muted:#8696a0; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:var(--wa-bg); color:var(--wa-text); height:100vh; display:flex; flex-direction:column; }
  header { background:var(--wa-panel); padding:10px 16px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #222d34; }
  header .avatar { width:38px; height:38px; border-radius:50%; background:var(--wa-out); display:flex; align-items:center; justify-content:center; font-weight:700; }
  header .meta { flex:1; }
  header .meta b { display:block; font-size:15px; }
  header .meta span { font-size:12px; color:var(--wa-muted); }
  header button { background:#2a3942; color:var(--wa-text); border:0; border-radius:6px; padding:8px 12px; cursor:pointer; font-size:13px; }
  header button:hover { background:#37474f; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:6px; background-image:linear-gradient(rgba(11,20,26,.95),rgba(11,20,26,.95)); }
  .row { display:flex; }
  .row.out { justify-content:flex-end; }
  .bubble { max-width:75%; padding:7px 10px 8px; border-radius:8px; font-size:14.5px; line-height:1.35; white-space:pre-wrap; word-wrap:break-word; }
  .out .bubble { background:var(--wa-out); border-top-right-radius:2px; }
  .in .bubble { background:var(--wa-in); border-top-left-radius:2px; }
  .dbg { align-self:center; font-size:11px; color:var(--wa-muted); background:#182229; padding:3px 10px; border-radius:10px; margin:4px 0; }
  .typing { font-size:13px; color:var(--wa-muted); padding:4px 10px; }
  footer { background:var(--wa-panel); padding:10px 12px; display:flex; gap:10px; }
  footer input { flex:1; background:#2a3942; border:0; border-radius:20px; padding:11px 16px; color:var(--wa-text); font-size:15px; outline:none; }
  footer button { background:var(--wa-out); border:0; color:#fff; width:44px; height:44px; border-radius:50%; cursor:pointer; font-size:18px; }
  footer button:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
<header>
  <div class="avatar">GP</div>
  <div class="meta"><b>GreatPhones (agente)</b><span id="phone"></span></div>
  <label style="font-size:12px;color:var(--wa-muted);display:flex;align-items:center;gap:5px;cursor:pointer" title="Espera 5 min antes de responder y tipea ~2s por renglón, igual que en WhatsApp real">
    <input type="checkbox" id="realtime"> tiempos reales (5 min)
  </label>
  <button id="reset">Nuevo cliente</button>
</header>
<div id="log"></div>
<div class="typing" id="typing" style="display:none">escribiendo…</div>
<footer>
  <input id="msg" placeholder="Escribí un mensaje" autocomplete="off">
  <button id="send">➤</button>
</footer>
<script>
  const log = document.getElementById('log');
  const input = document.getElementById('msg');
  const sendBtn = document.getElementById('send');
  const typing = document.getElementById('typing');
  const phoneEl = document.getElementById('phone');
  let phone = newPhone();

  function newPhone(){ return '549' + Math.floor(1000000000 + Math.random()*8999999999); }
  function setPhone(){ phoneEl.textContent = 'simulando +' + phone; }
  setPhone();

  const rtBox = document.getElementById('realtime');
  try { rtBox.checked = localStorage.getItem('gp_realtime') === '1'; } catch(e){}
  rtBox.onchange = () => { try { localStorage.setItem('gp_realtime', rtBox.checked ? '1' : '0'); } catch(e){} };

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  // Mismo criterio que src/integrations/kommo/handler.ts: ~2s por renglón (42 chars/renglón)
  const renglones = (t) => t.split('\\n').reduce((n,l) => n + Math.max(1, Math.ceil(l.trim().length/42)), 0);
  const typingDelay = (t) => Math.min(22000, Math.max(2000, renglones(t) * 2000 * rand(0.85, 1.2)));

  function addBubble(text, dir){
    const row = document.createElement('div');
    row.className = 'row ' + dir;
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    row.appendChild(b);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function addDebug(a){
    const d = document.createElement('div');
    d.className = 'dbg';
    d.textContent = \`estado: \${a.estado} · score: \${a.lead_score} · intención: \${a.intencion} · acción: \${a.accion_venta}\${a.requiere_humano ? ' · 🔴 nota al equipo (atender)' : ''}\`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  const DEBOUNCE_MS = 5 * 60 * 1000; // 5 min en modo real
  let pending = [];
  let debounceTimer = null;
  let countdownTimer = null;

  function send(){
    const text = input.value.trim();
    if(!text) return;
    input.value = '';
    addBubble(text, 'out');
    pending.push(text);
    clearTimeout(debounceTimer);
    clearInterval(countdownTimer);
    // El debounce va SIEMPRE (así podés mandar la consulta en varios mensajes).
    // En modo real espera 5 min tras tu último mensaje; en modo rápido, 3s.
    const dwell = rtBox.checked ? DEBOUNCE_MS : 3000;
    debounceTimer = setTimeout(fireTurn, dwell);
    if(rtBox.checked){
      let restante = Math.round(dwell / 1000);
      typing.style.display = 'block';
      typing.textContent = 'va a responder en ~5 min (modo real)…';
      countdownTimer = setInterval(() => {
        restante -= 1;
        const m = Math.floor(restante/60), s = restante%60;
        typing.textContent = 'va a responder en ' + m + ':' + String(s).padStart(2,'0') + ' …';
        if(restante <= 0){ clearInterval(countdownTimer); typing.textContent = 'escribiendo…'; }
      }, 1000);
    } else {
      typing.style.display = 'block';
      typing.textContent = 'escribiendo…';
    }
  }

  async function fireTurn(){
    clearInterval(countdownTimer);
    if(pending.length === 0) return;
    const text = pending.join('\\n');
    pending = [];
    sendBtn.disabled = true;
    typing.style.display = 'block';
    typing.textContent = 'escribiendo…';
    try{
      const r = await fetch('/message', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ phone, message: text, channel:'web' })
      });
      const j = await r.json();
      if(!j.ok){ typing.style.display = 'none'; addBubble('⚠️ error: ' + (j.error?.message || 'desconocido'), 'in'); return; }
      const ar = j.data.agentResponse;
      const rt = rtBox.checked;

      // Modo B: el agente se calló, sigue un asesor
      if(ar.pasar_a_humano || !(j.data.respuesta || '').trim()){
        await wait(rt ? 2000 : 150);
        typing.style.display = 'none';
        const d = document.createElement('div');
        d.className = 'dbg';
        d.textContent = '🟡 el agente no respondió — un asesor continúa esta conversación';
        log.appendChild(d); log.scrollTop = log.scrollHeight;
        addDebug(ar);
        return;
      }

      const parts = ar.fragmentos || [j.data.respuesta];

      // La espera larga (debounce ~10s) ya pasó — sólo una pausa natural corta
      await wait(rt ? 1200 + Math.random()*1300 : 150);

      // cada fragmento tras su tiempo de tipeo (~2s por renglón)
      for(let i = 0; i < parts.length; i++){
        const td = rt ? typingDelay(parts[i]) : 250;
        typing.style.display = 'block';
        typing.textContent = 'escribiendo…';
        await wait(td);
        typing.style.display = 'none';
        addBubble(parts[i], 'in');
      }
      typing.style.display = 'none';
      addDebug(j.data.agentResponse);
    }catch(e){
      typing.style.display = 'none';
      addBubble('⚠️ no se pudo conectar con el servidor', 'in');
    }finally{
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', e => { if(e.key === 'Enter') send(); });
  document.getElementById('reset').onclick = () => {
    phone = newPhone(); setPhone(); log.innerHTML = '';
    addBubble('— nueva conversación con un cliente nuevo —', 'in');
  };
  input.focus();
</script>
</body>
</html>`;
