const DEMO_APPS = [
  {
    name: 'Welcome to AppHub',
    description: 'A quick-start guide showing how AppHub works. This is a demo app — feel free to explore!',
    icon: '👋',
    original_filename: 'welcome.html',
    file_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to AppHub</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.card{background:rgba(255,255,255,.12);backdrop-filter:blur(20px);border-radius:24px;padding:48px;max-width:560px;width:90%;text-align:center;border:1px solid rgba(255,255,255,.2)}
h1{font-size:2.2rem;margin-bottom:12px}
.subtitle{font-size:1.1rem;opacity:.85;margin-bottom:32px}
.features{text-align:left;margin-bottom:32px}
.feature{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px}
.feature span{font-size:1.6rem}
.feature div h3{font-size:1rem;margin-bottom:2px}
.feature div p{font-size:.9rem;opacity:.75}
.badge{display:inline-block;background:rgba(255,255,255,.2);border-radius:99px;padding:6px 18px;font-size:.85rem;letter-spacing:.5px}
</style>
</head>
<body>
<div class="card">
  <h1>Welcome to AppHub 👋</h1>
  <p class="subtitle">Your team's app portal — upload, organise, and share internal tools.</p>
  <div class="features">
    <div class="feature"><span>📤</span><div><h3>Upload Apps</h3><p>Drag-and-drop HTML files to publish instantly.</p></div></div>
    <div class="feature"><span>📁</span><div><h3>Organise into Folders</h3><p>Drag one app onto another to create a folder — just like your phone.</p></div></div>
    <div class="feature"><span>👥</span><div><h3>Team Sharing</h3><p>Control who sees what with visibility settings.</p></div></div>
    <div class="feature"><span>🤖</span><div><h3>AI Conversion</h3><p>Upload any file and let AI convert it to a web app (Pro).</p></div></div>
  </div>
  <span class="badge">DEMO APP</span>
</div>
</body>
</html>`
  },
  {
    name: 'Sample Calculator',
    description: 'A simple calculator demo. Shows what a typical internal tool looks like on AppHub.',
    icon: '🧮',
    original_filename: 'calculator.html',
    file_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calculator</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;display:flex;align-items:center;justify-content:center;min-height:100vh}
.calc{background:#16213e;border-radius:20px;padding:24px;width:320px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.display{background:#0f3460;border-radius:12px;padding:20px;text-align:right;margin-bottom:16px;min-height:72px;display:flex;flex-direction:column;justify-content:flex-end}
.display .prev{color:#8892b0;font-size:.85rem;min-height:20px}
.display .current{color:#e94560;font-size:2rem;font-weight:700;word-break:break-all}
.buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
button{border:none;border-radius:12px;padding:18px;font-size:1.1rem;font-weight:600;cursor:pointer;transition:transform .1s,background .15s}
button:active{transform:scale(.95)}
.num{background:#1a1a2e;color:#fff}
.num:hover{background:#252545}
.op{background:#e94560;color:#fff}
.op:hover{background:#d63851}
.special{background:#0f3460;color:#8892b0}
.special:hover{background:#1a4a80}
.equals{grid-column:span 2}
.badge{text-align:center;margin-top:16px;font-size:.75rem;color:#8892b0;letter-spacing:1px}
</style>
</head>
<body>
<div class="calc">
  <div class="display"><div class="prev" id="prev"></div><div class="current" id="display">0</div></div>
  <div class="buttons">
    <button class="special" onclick="clearAll()">AC</button>
    <button class="special" onclick="toggleSign()">±</button>
    <button class="special" onclick="percentage()">%</button>
    <button class="op" onclick="setOp('/')">÷</button>
    <button class="num" onclick="append('7')">7</button>
    <button class="num" onclick="append('8')">8</button>
    <button class="num" onclick="append('9')">9</button>
    <button class="op" onclick="setOp('*')">×</button>
    <button class="num" onclick="append('4')">4</button>
    <button class="num" onclick="append('5')">5</button>
    <button class="num" onclick="append('6')">6</button>
    <button class="op" onclick="setOp('-')">−</button>
    <button class="num" onclick="append('1')">1</button>
    <button class="num" onclick="append('2')">2</button>
    <button class="num" onclick="append('3')">3</button>
    <button class="op" onclick="setOp('+')">+</button>
    <button class="num" onclick="append('0')" style="grid-column:span 2">0</button>
    <button class="num" onclick="append('.')">.</button>
    <button class="op equals" onclick="calc()">=</button>
  </div>
  <div class="badge">DEMO APP</div>
</div>
<script>
let current='0',prev='',op='',reset=false;
const d=document.getElementById('display'),p=document.getElementById('prev');
function update(){d.textContent=current;p.textContent=prev;}
function append(v){if(reset){current='';reset=false}if(v==='.'&&current.includes('.'))return;if(current==='0'&&v!=='.')current='';current+=v;update()}
function setOp(o){if(op&&!reset)calc();prev=current+' '+{'/':'÷','*':'×','-':'−','+':'+'}[o];op=o;reset=true;update()}
function calc(){if(!op)return;const a=parseFloat(prev),b=parseFloat(current);let r=0;if(op==='+')r=a+b;else if(op==='-')r=a-b;else if(op==='*')r=a*b;else if(op==='/')r=b!==0?a/b:'Error';current=String(r);prev='';op='';reset=true;update()}
function clearAll(){current='0';prev='';op='';reset=false;update()}
function toggleSign(){current=String(-parseFloat(current));update()}
function percentage(){current=String(parseFloat(current)/100);update()}
</script>
</body>
</html>`
  },
  {
    name: 'Team Notes',
    description: 'A collaborative sticky-notes board demo. Shows rich interactive apps running inside AppHub.',
    icon: '📝',
    original_filename: 'notes.html',
    file_content: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Notes</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;min-height:100vh;padding:24px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
h1{color:#fff;font-size:1.4rem}
button.add{background:#e94560;color:#fff;border:none;border-radius:12px;padding:10px 20px;font-size:.9rem;font-weight:600;cursor:pointer}
button.add:hover{background:#d63851}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.note{border-radius:16px;padding:20px;min-height:180px;display:flex;flex-direction:column;position:relative}
.note textarea{flex:1;background:transparent;border:none;color:inherit;font-size:.95rem;resize:none;font-family:inherit;outline:none}
.note .meta{font-size:.75rem;opacity:.6;margin-top:8px}
.note .delete{position:absolute;top:10px;right:12px;background:none;border:none;font-size:1rem;cursor:pointer;opacity:.4;transition:opacity .15s}
.note .delete:hover{opacity:1}
.badge{text-align:center;margin-top:24px;font-size:.75rem;color:#555;letter-spacing:1px}
</style>
</head>
<body>
<header><h1>📝 Team Notes</h1><button class="add" onclick="addNote()">+ New Note</button></header>
<div class="board" id="board"></div>
<div class="badge">DEMO APP</div>
<script>
const colors=[['#ffeaa7','#2d3436'],['#fd79a8','#fff'],['#74b9ff','#2d3436'],['#a29bfe','#fff'],['#55efc4','#2d3436'],['#fab1a0','#2d3436']];
let notes=[
  {id:1,text:'Welcome to Team Notes!\\nThis is a demo app showing what interactive tools look like in AppHub.',color:0},
  {id:2,text:'Try clicking "+ New Note" to add more sticky notes to the board.',color:1},
  {id:3,text:'Each team member can upload their own tools and utilities to share with the group.',color:2}
];
let nextId=4;
function render(){const b=document.getElementById('board');b.innerHTML='';notes.forEach(n=>{const[bg,fg]=colors[n.color%colors.length];b.innerHTML+=\`<div class="note" style="background:\${bg};color:\${fg}"><button class="delete" onclick="del(\${n.id})">✕</button><textarea oninput="upd(\${n.id},this.value)">\${n.text}</textarea><div class="meta">Note #\${n.id}</div></div>\`})}
function addNote(){notes.push({id:nextId++,text:'',color:Math.floor(Math.random()*colors.length)});render();const textareas=document.querySelectorAll('textarea');textareas[textareas.length-1].focus()}
function del(id){notes=notes.filter(n=>n.id!==id);render()}
function upd(id,v){const n=notes.find(x=>x.id===id);if(n)n.text=v}
render();
</script>
</body>
</html>`
  }
];

async function seedDemoApps(client, workspaceId, userId) {
  for (let i = 0; i < DEMO_APPS.length; i++) {
    const app = DEMO_APPS[i];
    await client.query(
      `INSERT INTO apps (workspace_id, uploaded_by, name, description, icon,
        file_content, original_filename, file_size, sort_order, visibility, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'team', true)`,
      [
        workspaceId, userId, app.name, app.description, app.icon,
        app.file_content, app.original_filename, Buffer.byteLength(app.file_content, 'utf-8'), i
      ]
    );
  }
}

module.exports = { DEMO_APPS, seedDemoApps };
