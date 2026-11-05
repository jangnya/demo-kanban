// Demo Internlog: Kanban + integrasi GitHub webhook.
// Jalankan: node server.js   (Node 18+, tanpa npm install)
// Aturan: commit yang pesannya memuat "#<id>" atau "card-<id>" memindahkan kartu ke Need Approval.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || '';   // isi sama dengan secret di GitHub
const DATA = path.join(__dirname, 'data.json');

let db = {
  nextId: 4,
  cards: [
    { id: 1, title: 'Buat halaman login', status: 'doing', commits: [] },
    { id: 2, title: 'Buat API daftar peserta', status: 'todo', commits: [] },
    { id: 3, title: 'Perbaiki bug logbook', status: 'todo', commits: [] },
  ],
  events: [],
};
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
const log = (msg) => { db.events.unshift({ time: new Date().toISOString(), msg }); db.events = db.events.slice(0, 20); };

// ---- inti integrasi: baca payload push GitHub, cocokkan ke kartu ----
function extractIds(text) {
  const ids = new Set(); const re = /(?:#|card-)(\d+)/gi; let m;
  while ((m = re.exec(text || '')) !== null) ids.add(Number(m[1]));
  return ids;
}
function processPush(payload) {
  const repo = (payload.repository && payload.repository.full_name) || 'repo';
  const refIds = extractIds(payload.ref);               // mis. branch "feature/card-3"
  let moved = 0, linked = 0;
  for (const c of payload.commits || []) {
    const ids = new Set([...extractIds(c.message), ...refIds]);
    if (!ids.size) { log('Commit ' + String(c.id).slice(0, 7) + ' di ' + repo + ' tidak memuat ID kartu, diabaikan'); continue; }
    for (const id of ids) {
      const card = db.cards.find((x) => x.id === id);
      if (!card) { log('Commit ' + String(c.id).slice(0, 7) + ' menyebut kartu #' + id + ' yang tidak ada'); continue; }
      const sha = String(c.id).slice(0, 7);
      if (card.commits.some((x) => x.sha === sha)) continue;   // anti duplikat (redelivery)
      card.commits.push({ sha, message: String(c.message || '').split('\n')[0],
        author: (c.author && c.author.name) || '?', url: c.url || '', time: c.timestamp || new Date().toISOString() });
      linked++;
      if (card.status === 'todo' || card.status === 'doing') { card.status = 'need_approval'; moved++; }
      log('Commit ' + sha + ' oleh ' + ((c.author && c.author.name) || '?') + ' tertaut ke kartu #' + id + (card.status === 'need_approval' ? ' → Need Approval' : ''));
    }
  }
  save();
  return { linked, moved };
}

function verifySignature(raw, header) {
  if (!SECRET) return true;                              // tanpa secret: lewati verifikasi (hanya untuk demo)
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const readBody = (req) => new Promise((resolve) => { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => resolve(Buffer.concat(ch))); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, db);

    if (req.method === 'POST' && url === '/webhook/github') {
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'])) { log('Webhook ditolak: signature tidak valid'); save(); return send(res, 401, { error: 'invalid signature' }); }
      const event = req.headers['x-github-event'];
      if (event === 'ping') { log('Webhook GitHub terhubung (ping)'); save(); return send(res, 200, { ok: true }); }
      if (event !== 'push') return send(res, 200, { ignored: event });
      return send(res, 200, processPush(JSON.parse(raw.toString('utf8'))));
    }

    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (url === '/api/cards') {
        db.cards.push({ id: db.nextId++, title: String(body.title || 'Tanpa judul'), status: 'todo', commits: [] });
        save(); return send(res, 200, { ok: true });
      }
      const m = url.match(/^\/api\/cards\/(\d+)\/status$/);
      if (m) {
        const card = db.cards.find((x) => x.id === Number(m[1]));
        if (!card) return send(res, 404, { error: 'not found' });
        card.status = body.status; log('Kartu #' + card.id + ' dipindah manual ke ' + body.status); save(); return send(res, 200, { ok: true });
      }
      if (url === '/api/simulate') {   // simulasi push tanpa GitHub (memakai fungsi yang sama dengan webhook)
        const payload = { ref: 'refs/heads/main', repository: { full_name: 'demo/repo' },
          commits: [{ id: crypto.randomBytes(20).toString('hex'), message: String(body.message || ''), author: { name: String(body.author || 'peserta') }, url: '', timestamp: new Date().toISOString() }] };
        return send(res, 200, processPush(payload));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});

const HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Internlog Kanban Demo</title>
<style>
body{font-family:sans-serif;margin:16px}
.board{display:flex;gap:12px;align-items:flex-start}
.col{flex:1;background:#f0f0f0;padding:8px;min-height:200px}
.card{background:#fff;border:1px solid #ccc;padding:8px;margin:8px 0}
.commit{font-size:12px;color:#555;border-top:1px dashed #ccc;margin-top:6px;padding-top:4px}
button{margin:2px}
#events{font-size:12px;background:#fafafa;border:1px solid #ddd;padding:8px;max-height:180px;overflow:auto}
</style></head><body>
<h2>Internlog Kanban Demo</h2>
<p>Commit dengan pesan memuat <b>#ID</b> atau <b>card-ID</b> (contoh: "fix login #1") memindahkan kartu ke <b>Need Approval</b>.</p>
<div class="board" id="board"></div>
<h3>Tambah kartu</h3>
<input id="newTitle" placeholder="Judul kartu"><button onclick="addCard()">Tambah</button>
<h3>Simulasi push (tanpa GitHub)</h3>
<input id="simMsg" placeholder='Pesan commit, mis. "fix login #1"' size="30"><input id="simAuthor" placeholder="Author" value="budi"><button onclick="sim()">Kirim</button>
<h3>Log webhook</h3><div id="events"></div>
<script>
var COLS=[['todo','To Do'],['doing','Doing'],['need_approval','Need Approval'],['done','Done']];
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});}
function setStatus(id,s){post('/api/cards/'+id+'/status',{status:s}).then(load);}
function addCard(){var t=document.getElementById('newTitle');post('/api/cards',{title:t.value}).then(function(){t.value='';load();});}
function sim(){post('/api/simulate',{message:document.getElementById('simMsg').value,author:document.getElementById('simAuthor').value}).then(load);}
function btns(c){
  var i=COLS.map(function(x){return x[0];}).indexOf(c.status),h='';
  if(c.status==='need_approval'){return '<button onclick="setStatus('+c.id+',\\'done\\')">Approve</button><button onclick="setStatus('+c.id+',\\'doing\\')">Revisi</button>';}
  if(i>0)h+='<button onclick="setStatus('+c.id+',\\''+COLS[i-1][0]+'\\')">&larr;</button>';
  if(i<3)h+='<button onclick="setStatus('+c.id+',\\''+COLS[i+1][0]+'\\')">&rarr;</button>';
  return h;
}
function render(s){
  document.getElementById('board').innerHTML=COLS.map(function(col){
    var cards=s.cards.filter(function(c){return c.status===col[0];}).map(function(c){
      var cm=c.commits.map(function(x){return '<div class="commit">commit '+esc(x.sha)+' oleh '+esc(x.author)+': '+esc(x.message)+'</div>';}).join('');
      return '<div class="card"><b>#'+c.id+'</b> '+esc(c.title)+'<div>'+btns(c)+'</div>'+cm+'</div>';
    }).join('');
    return '<div class="col"><b>'+col[1]+'</b>'+cards+'</div>';
  }).join('');
  document.getElementById('events').innerHTML=s.events.map(function(e){return esc(e.time.slice(11,19))+' '+esc(e.msg);}).join('<br>')||'(belum ada event)';
}
function load(){fetch('/api/state').then(function(r){return r.json();}).then(render);}
load();setInterval(load,2000);
</script></body></html>`;

server.listen(PORT, () => console.log('Demo jalan di http://localhost:' + PORT + (SECRET ? ' (verifikasi signature aktif)' : ' (tanpa secret)')));
