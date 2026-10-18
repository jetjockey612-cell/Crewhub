/* Crew Hub shared trip store.
   Up to 3 imported trip sheets live in this device's localStorage. One is "active".
   Every tool reads the active trip through this file, so a PDF only has to be imported once.
   Each trip keeps the raw PDF text, so each tool can run its own existing parser on it. */
(function(){
  'use strict';
  var KEY = 'crewhub_trips_v1';
  var MAX = 3;
  var MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  var MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function load(){
    try {
      var o = JSON.parse(localStorage.getItem(KEY));
      if(o && Array.isArray(o.trips)) return o;
    } catch(e){}
    return { active: null, trips: [] };
  }
  function save(s){
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch(e){ return false; }
    try { window.dispatchEvent(new CustomEvent('hubtrips')); } catch(e){}
    return true;
  }

  function list(){ return load().trips; }
  function active(){
    var s = load();
    for(var i=0;i<s.trips.length;i++){ if(s.trips[i].id === s.active) return s.trips[i]; }
    return s.trips[0] || null;
  }
  function setActive(id){
    var s = load();
    if(s.trips.some(function(t){ return t.id === id; })){ s.active = id; save(s); }
  }
  function remove(id){
    var s = load();
    s.trips = s.trips.filter(function(t){ return t.id !== id; });
    if(s.active === id) s.active = s.trips.length ? s.trips[0].id : null;
    save(s);
  }

  // ---------- PDF reading ----------
  async function extract(file){
    if(!window.pdfjsLib) throw new Error('pdf');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    var buf = await file.arrayBuffer();
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    var items = [], text = '';
    for(var p = 1; p <= doc.numPages; p++){
      var page = await doc.getPage(p);
      var content = await page.getTextContent();
      var lastY = null, line = '';
      for(var k = 0; k < content.items.length; k++){
        var it = content.items[k];
        items.push(it.str);
        var y = it.transform[5];
        if(lastY !== null && Math.abs(y - lastY) > 2){ text += line + '\n'; line = ''; }
        line += it.str + ' ';
        lastY = y;
      }
      text += line + '\n\n';
    }
    return { items: items, text: text };
  }

  // ---------- Summary parse (for the trip cards, the ETE flag and tool pre-fill) ----------
  function after(items, label){
    for(var i=0;i<items.length;i++){ if(items[i].trim() === label) return i; }
    return -1;
  }
  function crewName(items, role){
    for(var i=0;i<items.length;i++){
      if(items[i].trim() === role){
        for(var j=i+1;j<items.length && j<i+6;j++){ var s = items[j].trim(); if(s) return s; }
      }
    }
    return null;
  }
  function displayName(raw){
    if(!raw) return null;
    var parts = raw.split(',');
    var last = (parts[0] || '').trim();
    var first = ((parts[1] || '').trim().split(/\s+/)[0]) || '';
    return (first + ' ' + last).trim();
  }
  function parseSummary(items){
    var airportRe = /^([A-Z0-9]{3,4})\s*\(.+\)$/;
    var dtRe = /^[A-Za-z]{3}\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})$/;
    var legRe = /^LEG\s+\d+$/i;
    var eteRe = /^(\d{1,2}):(\d{2})$/;
    var out = { tripNum: null, tail: null, model: null, pic: null, sic: null, legs: [] };

    for(var a=0;a<items.length;a++){
      var m = items[a].trim().match(/^TRIP\s+([A-Z0-9]+)\s*:/i);
      if(m){ out.tripNum = m[1]; break; }
    }
    var ti = after(items, 'TAIL NUMBER:'); if(ti > 0) out.tail = (items[ti-1] || '').trim() || null;
    var mi = after(items, 'AIRCRAFT MODEL:'); if(mi > 0) out.model = (items[mi-1] || '').trim() || null;
    out.pic = displayName(crewName(items, 'PIC'));
    out.sic = displayName(crewName(items, 'SIC'));

    for(var i=0;i<items.length;i++){
      if(!legRe.test(items[i].trim())) continue;
      var orig = null, dest = null, pax = null, nm = null, ete = null;
      var dts = [];
      for(var j=i+1;j<items.length && j<i+250;j++){
        var s = items[j].trim();
        if(legRe.test(s)) break;
        if(!orig || !dest){
          var am = s.match(airportRe);
          if(am){ if(!orig) orig = am[1]; else dest = am[1]; continue; }
        }
        if(orig && dest){
          if(dts.length === 0 && pax === null){ var pm = s.match(/^(\d{1,2})$/); if(pm){ pax = parseInt(pm[1],10); continue; } }
          if(dts.length < 4){ var dm = s.match(dtRe); if(dm){ dts.push(dm); continue; } }
          if(dts.length >= 2){
            if(nm === null && /^\d{1,4}$/.test(s)){ nm = parseInt(s,10); continue; }
            if(ete === null){ var em = s.match(eteRe); if(em){ ete = parseInt(em[1],10)*60 + parseInt(em[2],10); break; } }
          }
        }
      }
      if(orig && dest && dts.length >= 2){
        var iso = function(dm){ return dm[3] + '-' + pad(MON.indexOf(dm[2].toLowerCase()) + 1) + '-' + pad(parseInt(dm[1],10)); };
        out.legs.push({
          orig: orig, dest: dest, pax: pax, nm: nm, eteMin: ete,
          depDate: iso(dts[0]), depLocal: dts[0][4] + dts[0][5],
          arrDate: iso(dts[1]), arrLocal: dts[1][4] + dts[1][5],
          depZ: dts[2] ? dts[2][4] + dts[2][5] : null,
          arrZ: dts[3] ? dts[3][4] + dts[3][5] : null
        });
      }
    }
    return out;
  }
  function pad(n){ return (n < 10 ? '0' : '') + n; }

  function dateLabel(iso){
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1]-1, +p[2]));
    return DAY_NAMES[d.getUTCDay()] + ' ' + MONTH_NAMES[+p[1]-1] + ' ' + (+p[2]);
  }
  function routeOf(legs){
    if(!legs.length) return '';
    var r = [legs[0].orig];
    legs.forEach(function(l){ if(r[r.length-1] !== l.orig) r.push(l.orig); r.push(l.dest); });
    return r.join(' \u2192 ');
  }
  function eteText(min){
    if(min == null) return '';
    return Math.floor(min/60) + ':' + pad(min % 60);
  }

  // ---------- Import ----------
  async function importFile(file){
    var ex;
    try { ex = await extract(file); }
    catch(e){ return { error: 'read', message: 'Could not read that PDF.' }; }
    var sum = parseSummary(ex.items);
    if(!sum.legs.length) return { error: 'noLegs', message: 'No legs found. Is this a Cook trip sheet?' };

    var s = load();
    var id = sum.tripNum || ('T' + Date.now());
    var first = sum.legs[0], last = sum.legs[sum.legs.length-1];
    var label = dateLabel(first.depDate);
    if(last.arrDate !== first.depDate) label += ' – ' + dateLabel(last.arrDate);
    var trip = {
      id: id, tripNum: sum.tripNum || '', tail: sum.tail || '', model: sum.model || '',
      pic: sum.pic || '', sic: sum.sic || '', legs: sum.legs,
      route: routeOf(sum.legs), dateLabel: label, savedAt: Date.now(),
      items: ex.items, text: ex.text
    };
    var idx = -1;
    s.trips.forEach(function(t, i){ if(t.id === id) idx = i; });
    var replaced = idx >= 0;
    if(replaced){ s.trips[idx] = trip; }
    else {
      if(s.trips.length >= MAX) return { error: 'full', message: 'You already have ' + MAX + ' trips. Remove one first.' };
      s.trips.push(trip);
    }
    s.active = id;
    if(!save(s)) return { error: 'storage', message: 'Could not save on this device (storage full or blocked).' };
    return { ok: true, trip: trip, replaced: replaced };
  }

  // ---------- Small trip switcher for the tools ----------
  var cssDone = false;
  function injectCss(){
    if(cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.hb{margin:0 0 16px;padding:12px 14px;border:1px solid var(--line,var(--panel-border,#2f3b49));border-radius:12px;background:var(--panel,#151d28);color:var(--text,#e6edf3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '.hb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.hb-l{font-size:14px;font-weight:600;color:var(--text-dim,#8c9aa8)}' +
      '.hb select{flex:1 1 180px;min-width:0;min-height:44px;padding:0 10px;font-size:16px;border-radius:8px;border:1px solid var(--line,var(--panel-border,#2f3b49));background:var(--panel-raised,var(--bg,#0d1117));color:var(--text,#e6edf3)}' +
      '.hb button{min-height:44px;padding:0 16px;font-size:15px;font-weight:600;border-radius:8px;border:1px solid var(--amber,#ffb300);background:transparent;color:var(--amber,#ffb300)}' +
      '.hb button:active{opacity:.7}' +
      '.hb-msg{margin-top:8px;font-size:14px;color:var(--text-dim,#8c9aa8);line-height:1.4}' +
      '.hb-msg a{color:var(--amber,#ffb300)}';
    document.head.appendChild(st);
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  // opts: { onSelect(trip) - after the person picks a trip, loadLabel, onLoad(trip), hint }
  function bar(mount, opts){
    opts = opts || {};
    injectCss();
    var el = (typeof mount === 'string') ? document.getElementById(mount) : mount;
    if(!el) return null;
    el.className = 'hb';
    function render(){
      var trips = list(), act = active();
      if(!trips.length){
        el.innerHTML = '<div class="hb-msg" style="margin:0">No trip imported yet. <a href="index.html">Import a trip sheet on the Home screen</a> and it will show up here.</div>';
        return;
      }
      el.innerHTML =
        '<div class="hb-row"><span class="hb-l">Trip</span>' +
        '<select aria-label="Active trip">' + trips.map(function(t){
          return '<option value="' + esc(t.id) + '"' + (act && t.id === act.id ? ' selected' : '') + '>' +
            esc(t.dateLabel + (t.tail ? ' · ' + t.tail : '') + ' · ' + t.route) + '</option>';
        }).join('') + '</select>' +
        (opts.onLoad ? '<button type="button">' + esc(opts.loadLabel || 'Load') + '</button>' : '') +
        '</div>' + (opts.hint ? '<div class="hb-msg">' + esc(opts.hint) + '</div>' : '');
      var sel = el.querySelector('select');
      sel.addEventListener('change', function(){
        setActive(sel.value);
        if(opts.onSelect) opts.onSelect(active());
      });
      var btn = el.querySelector('button');
      if(btn) btn.addEventListener('click', function(){ if(opts.onLoad) opts.onLoad(active()); });
    }
    render();
    window.addEventListener('hubtrips', render);
    window.addEventListener('storage', function(e){ if(e.key === KEY) render(); });
    return { refresh: render, setMessage: function(t){
      var m = el.querySelector('.hb-msg');
      if(!m){ m = document.createElement('div'); m.className = 'hb-msg'; el.appendChild(m); }
      m.textContent = t;
    } };
  }

  window.HubTrips = {
    MAX: MAX, list: list, active: active, setActive: setActive, remove: remove,
    importFile: importFile, parseSummary: parseSummary, bar: bar, eteText: eteText, dateLabel: dateLabel
  };
})();
