const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8770;
const PERSONAS_DIR = path.join(__dirname, 'personas');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);
const IMAGES_DIR = path.join(__dirname, 'images');
const ARCHIVE_DIR = path.join(IMAGES_DIR, 'archive');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const MEMORIES_DIR = path.join(__dirname, 'memories');
if (!fs.existsSync(MEMORIES_DIR)) fs.mkdirSync(MEMORIES_DIR);

// === CONVERSATION LOGGING SYSTEM ===
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// Logging toggle - can be disabled via API
let loggingEnabled = true;

// Fast async logger - appends JSONL, never blocks
const logQueue = [];
let logFlushTimer = null;

function logConversation(entry) {
  logQueue.push(entry);
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 100); // Batch writes every 100ms
  }
}

function flushLogs() {
  logFlushTimer = null;
  if (logQueue.length === 0) return;
  
  const entries = logQueue.splice(0, logQueue.length);
  const byFile = {};
  
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const month = date.toISOString().slice(0, 7); // YYYY-MM
    const monthDir = path.join(LOGS_DIR, month);
    if (!fs.existsSync(monthDir)) fs.mkdirSync(monthDir, { recursive: true });
    
    const filename = `${entry.persona_id || 'unknown'}.jsonl`;
    const filepath = path.join(monthDir, filename);
    
    if (!byFile[filepath]) byFile[filepath] = [];
    byFile[filepath].push(JSON.stringify(entry));
  }
  
  // Async append to each file
  for (const [filepath, lines] of Object.entries(byFile)) {
    fs.appendFile(filepath, lines.join('\n') + '\n', err => {
      if (err) console.error('Log write error:', err.message);
    });
  }
}

// Also write to combined daily log for easy tailing
function logToDaily(entry) {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  const dailyFile = path.join(LOGS_DIR, `${date}-all.jsonl`);
  fs.appendFile(dailyFile, JSON.stringify(entry) + '\n', err => {
    if (err) console.error('Daily log error:', err.message);
  });
}

// Flush logs on exit
process.on('exit', flushLogs);
process.on('SIGINT', () => { flushLogs(); process.exit(); });
process.on('SIGTERM', () => { flushLogs(); process.exit(); });

// Models organized by provider - LOCAL FIRST for easy selection
const LOCAL_MODELS = [
  "ollama/mistral-nemo:12b",
  "ollama/llama3.1:8b",
  "ollama/llama3.3:70b",
  "ollama/qwen3:30b-a3b",
  "ollama/dolphin-llama3:8b",
  "ollama/dolphin-llama3:70b"
];

const ANTHROPIC_MODELS = [
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-6"
];

const OPENROUTER_MODELS = [
  "openrouter/x-ai/grok-4.1-fast",
  "openrouter/x-ai/grok-4-fast",
  "openrouter/x-ai/grok-4",
  "openrouter/x-ai/grok-3",
  "openrouter/google/gemini-2.0-flash-001",
  "openrouter/meta-llama/llama-4-maverick",
  "openrouter/mistralai/mistral-large"
];

// Combined list for backward compatibility
const MODELS = [...LOCAL_MODELS, ...ANTHROPIC_MODELS, ...OPENROUTER_MODELS];

const TYPES = ["real", "fictional", "corporation", "nhi", "ai"];

function getPersonas() {
  return fs.readdirSync(PERSONAS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, f))));
}

function getPersona(id) {
  const file = path.join(PERSONAS_DIR, id + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file));
}

function callOllama(model, system, messages) {
  return new Promise((resolve, reject) => {
    // Ollama ignores top-level 'system' field — must inject as role:system message
    const msgsWithSystem = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const payload = JSON.stringify({ model, messages: msgsWithSystem, stream: false });
    const req = http.request({ hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).message?.content || 'No response'); } catch { resolve('Error'); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function callAnthropic(model, system, messages) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) return resolve('Anthropic API key not configured.');
    const payload = JSON.stringify({ model, max_tokens: 2048, system, messages });
    const req = https.request({ hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).content?.[0]?.text || 'No response'); } catch { resolve('Error: ' + d.slice(0, 100)); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function callOpenRouter(model, system, messages) {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_KEY) return resolve('OpenRouter API key not configured.');
    const msgsWithSystem = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const payload = JSON.stringify({ model, max_tokens: 2048, messages: msgsWithSystem });
    const req = https.request({ hostname: 'openrouter.ai', port: 443, path: '/api/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'HTTP-Referer': 'http://localhost:8770', 'X-Title': 'IdentityChannelerBot' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).choices?.[0]?.message?.content || 'No response'); } catch { resolve('Error: ' + d.slice(0, 100)); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function callLLM(persona, messages) {
  const model = persona.llm || 'ollama/mistral-nemo:12b';
  if (model.startsWith('ollama/')) return callOllama(model.replace('ollama/', ''), persona.system_prompt, messages);
  if (model.startsWith('anthropic/')) return callAnthropic(model.replace('anthropic/', ''), persona.system_prompt, messages);
  if (model.startsWith('openrouter/')) return callOpenRouter(model.replace('openrouter/', ''), persona.system_prompt, messages);
  // Fallback: try openrouter for anything else (grok, gemini, etc)
  if (OPENROUTER_KEY && !model.startsWith('ollama/')) return callOpenRouter(model, persona.system_prompt, messages);
  return 'Model not configured.';
}


async function generateImage(prompt, negPrompt = '') {
  const workflow = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "RealVisXL_V5.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negPrompt || "ugly, blurry, low quality, distorted", "clip": ["1", 1]}},
    "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 768, "height": 1024, "batch_size": 1}},
    "5": {"class_type": "KSampler", "inputs": {"seed": Math.floor(Math.random()*999999999), "steps": 25, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
    "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
    "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "channeler_", "images": ["6", 0]}}
  };
  
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ prompt: workflow });
    const req = http.request({ hostname: 'localhost', port: 8188, path: '/prompt', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.prompt_id) resolve({ ok: true, prompt_id: r.prompt_id });
          else resolve({ ok: false, error: r.error || 'Unknown error' });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

async function pollImage(promptId, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const histRes = await new Promise((resolve, reject) => {
        http.get('http://localhost:8188/history/' + promptId, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      
      if (histRes[promptId] && histRes[promptId].outputs) {
        for (const nodeId of Object.keys(histRes[promptId].outputs)) {
          const out = histRes[promptId].outputs[nodeId];
          if (out.images && out.images.length > 0) {
            const img = out.images[0];
            return { ok: true, filename: img.filename, subfolder: img.subfolder || '' };
          }
        }
      }
    } catch (e) { /* continue polling */ }
  }
  return { ok: false, error: 'Timeout waiting for image' };
}

function respond(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(data));
}

function renderPage() {
  const personas = getPersonas();
  const safe = personas.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, tagline: p.tagline, type: p.type, llm: p.llm, seed_questions: p.seed_questions, system_prompt: p.system_prompt }));

  const cards = personas.map(p => {
    const id = p.id.replace(/['"]/g, '');
    return '<div class="pcard" id="pc-' + id + '" data-id="' + id + '">'
      + '<input type="checkbox" class="pcheck" onclick="event.stopPropagation();toggleGroup(\'' + id + '\')">'
      + '<div class="pavatar">' + p.avatar + '</div>'
      + '<div class="pinfo"><div class="pname">' + p.name + '</div>'
      + '<div class="ptag">' + p.tagline + '</div>'
      + '<span class="ptype ' + p.type + '">' + p.type + '</span>'
      + '<div class="pmodel">' + p.llm + '</div>'
      + '</div>'
      + '<button class="gbtn" onclick="event.stopPropagation();openEdit(\'' + id + '\')">⚙</button>'
      + '</div>';
  }).join('');

  const personasJS = JSON.stringify(safe).replace(/</g, '\\u003c').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  const modelsJS = JSON.stringify(MODELS); // base models, extended dynamically
  const typesJS = JSON.stringify(TYPES);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>IdentityChannelerBot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{height:-webkit-fill-available}body{background:#0a0a14;color:#e0e0f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;height:100dvh;min-height:-webkit-fill-available;overflow:hidden;max-width:100vw}
header{background:#111128;padding:14px 24px;padding-top:max(14px,env(safe-area-inset-top));border-bottom:1px solid #7c6fff33;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:20px;font-weight:800;color:#7c6fff}.logo span{color:#00cfff}
.sub{font-size:11px;color:#445566;margin-top:2px}
.mode-btns{display:flex;gap:8px}
.mode-btn{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer}
.mode-btn:hover{border-color:#7c6fff44;color:#7c6fff}
.mode-btn.active{background:#7c6fff22;border-color:#7c6fff;color:#7c6fff}
.main{display:flex;flex:1;overflow:hidden;min-height:0;max-width:100vw}
.sidebar{width:280px;border-right:1px solid #ffffff11;display:flex;flex-direction:column;flex-shrink:0}
.stitle{padding:12px 16px;font-size:10px;color:#445566;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #ffffff08;display:flex;justify-content:space-between;align-items:center}
.newbtn{background:#7c6fff;color:#fff;border:none;padding:4px 10px;border-radius:4px;font-size:10px;cursor:pointer}
.plist{flex:1;overflow-y:auto;padding:8px}
.pcard{display:flex;gap:10px;padding:10px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:4px;transition:all 0.15s;position:relative;align-items:flex-start}
.pcard:hover{background:#1a1a2e;border-color:#ffffff11}
.pcard.active{background:#1a1a2e;border-color:#7c6fff66}
.pcard.ingroup{background:#00cfff11;border-color:#00cfff44}
.pcheck{display:none;width:18px;height:18px;margin-top:4px;flex-shrink:0;accent-color:#00cfff}
.group-mode .pcheck{display:block}
.group-mode .pcard{cursor:default}
.pavatar{font-size:26px;flex-shrink:0}
.pinfo{flex:1;min-width:0}
.pname{font-weight:700;color:#fff;font-size:13px}
.ptag{font-size:10px;color:#8899bb;margin-top:2px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ptype{display:inline-block;margin-top:4px;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:600}
.ptype.real{background:#00cfff22;color:#00cfff}
.ptype.fictional{background:#7c6fff22;color:#7c6fff}
.ptype.corporation{background:#ff990022;color:#ff9900}
.ptype.nhi{background:#00ff4422;color:#00ff44}
.ptype.ai{background:#ffd70022;color:#ffd700}
.pmodel{font-size:9px;color:#334455;margin-top:2px;font-family:monospace}
.gbtn{position:absolute;top:6px;right:6px;background:none;border:none;font-size:12px;cursor:pointer;opacity:0.3;transition:opacity 0.2s;color:#8899bb}
.gbtn:hover{opacity:1}
.model-switcher{padding:8px 12px;background:#0a0a14;border-bottom:1px solid #ffffff11;display:flex;align-items:center;gap:6px}
.model-switcher label{font-size:10px;color:#556677;white-space:nowrap}
.model-switcher select{flex:1;background:#111128;border:1px solid #ffffff22;color:#e0e0f0;padding:5px 8px;border-radius:4px;font-size:11px;min-width:0;max-width:calc(100% - 80px)}
.model-switcher button{background:#7c6fff;color:#fff;border:none;padding:5px 10px;border-radius:4px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;min-width:60px}
.group-bar{display:none;padding:10px 16px;background:#00cfff11;border-bottom:1px solid #00cfff33;font-size:12px;color:#00cfff}
.group-mode .group-bar{display:flex;align-items:center;justify-content:space-between}
.group-bar button{background:#00cfff;color:#000;border:none;padding:5px 12px;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer}
.chat{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;max-width:100%}
.empty{flex:1;display:flex;align-items:center;justify-content:center;color:#334455;font-size:15px;text-align:center;padding:20px}
#chatwrap{display:none;flex:1;flex-direction:column;overflow:hidden}
.cheader{padding:14px 20px;border-bottom:1px solid #ffffff11;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
.cheader-av{font-size:30px}
.cheader-participants{display:flex;gap:-8px;font-size:24px}
.cheader-participants span{margin-left:-6px}
.cheader-name{font-size:17px;font-weight:700;color:#fff}
.cheader-tag{font-size:11px;color:#8899bb}
.cheader-btns{margin-left:auto;display:flex;gap:8px}
.cbtn{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:5px 10px;border-radius:6px;font-size:10px;cursor:pointer}
.cbtn:hover{border-color:#7c6fff44;color:#7c6fff}
.msgs{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.msg{display:flex;gap:10px;max-width:78%}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg-av{font-size:18px;flex-shrink:0;margin-top:3px}
.bubble{background:#1a1a2e;border:1px solid #ffffff11;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.6;white-space:pre-wrap}
.msg.user .bubble{background:#7c6fff22;border-color:#7c6fff33}
.mname{font-size:10px;color:#556677;margin-bottom:3px;font-weight:600}
.msg-meta{font-size:9px;color:#445566;margin-top:6px;font-family:monospace;opacity:0.7}
.msg.user .mname{text-align:right}
.seeds{padding:10px 20px;border-top:1px solid #ffffff08;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0}.seeds-toggle{display:none;background:none;border:none;color:#556677;font-size:11px;cursor:pointer;padding:6px 14px;border-top:1px solid #ffffff08;width:100%;text-align:left;flex-shrink:0}
.sbtn{background:#111128;border:1px solid #ffffff11;color:#8899bb;padding:5px 10px;border-radius:16px;font-size:11px;cursor:pointer;transition:all 0.15s}
.sbtn:hover{border-color:#7c6fff44;color:#7c6fff}
.iarea{padding:12px 20px;padding-bottom:max(12px,env(safe-area-inset-bottom));border-top:1px solid #ffffff11;display:flex;gap:10px;flex-shrink:0;background:#0a0a14}
.iarea textarea{flex:1;background:#1a1a2e;border:1px solid #ffffff22;color:#e0e0f0;padding:10px 14px;border-radius:8px;font-size:13px;resize:none;outline:none;font-family:inherit}
.iarea textarea:focus{border-color:#7c6fff66}
.sendbtn{background:#7c6fff;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.sendbtn:hover{background:#9d8fff}
.sendbtn:disabled{opacity:0.4;cursor:default}
.typing{color:#556677;font-style:italic;font-size:12px}
.msg-img{max-width:100%;border-radius:8px;margin-top:8px;cursor:pointer}
.msg-img:hover{opacity:0.9}
.img-actions{display:flex;gap:6px;margin-top:6px}
.img-btn{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer}
.img-btn:hover{border-color:#7c6fff44;color:#7c6fff}
.img-btn.danger:hover{border-color:#ff446644;color:#ff4466}

.sessions-btn{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:4px 8px;border-radius:4px;font-size:10px;cursor:pointer;margin-left:8px}
.sessions-panel{display:none;position:fixed;top:60px;left:300px;width:350px;max-height:70vh;background:#111128;border:1px solid #7c6fff44;border-radius:12px;z-index:50;overflow:hidden;flex-direction:column}
.sessions-panel.open{display:flex}
.sessions-header{padding:12px 16px;border-bottom:1px solid #ffffff11;display:flex;justify-content:space-between;align-items:center}
.sessions-title{font-size:14px;font-weight:700;color:#fff}
.sessions-list{flex:1;overflow-y:auto;padding:8px}
.session-card{padding:10px 12px;background:#0a0a14;border:1px solid #ffffff11;border-radius:8px;margin-bottom:6px;cursor:pointer}
.session-card:hover{border-color:#7c6fff44}
.session-name{font-size:13px;font-weight:600;color:#fff}
.session-meta{font-size:10px;color:#556677;margin-top:4px}
.session-avatars{font-size:16px;margin-top:4px}
.session-actions{display:flex;gap:6px;margin-top:6px}
.session-actions button{font-size:10px;padding:3px 8px}
.save-session-row{padding:12px 16px;border-top:1px solid #ffffff11;display:flex;gap:8px}
.save-session-row input{flex:1;background:#0a0a14;border:1px solid #ffffff22;color:#e0e0f0;padding:6px 10px;border-radius:4px;font-size:12px}
.save-session-row button{background:#7c6fff;color:#fff;border:none;padding:6px 12px;border-radius:4px;font-size:12px;cursor:pointer}
.generating{padding:12px;background:#1a1a2e;border:1px solid #00cfff33;border-radius:8px;color:#00cfff;font-size:12px}
.lightbox{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:200;align-items:center;justify-content:center}
.lightbox.open{display:flex}
.lightbox img{max-width:90%;max-height:90%;border-radius:8px}
.lightbox-close{position:absolute;top:20px;right:20px;font-size:30px;color:#fff;cursor:pointer}

.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:100;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 20px}
.modal.open{display:flex}
.mbox{background:#111128;border:1px solid #7c6fff44;border-radius:12px;padding:24px;width:600px;max-width:100%}
.mtitle{font-size:18px;font-weight:700;margin-bottom:16px;color:#fff;display:flex;justify-content:space-between;align-items:center}
.mrow{margin-bottom:14px}
.mrow2{display:flex;gap:12px}
.mrow2 .mrow{flex:1;margin-bottom:0}
.mlabel{font-size:11px;color:#8899bb;margin-bottom:4px;display:block}
.minput,.msel,.mtextarea{width:100%;background:#0a0a14;border:1px solid #ffffff22;color:#e0e0f0;padding:8px 12px;border-radius:6px;font-size:13px;font-family:inherit}
select optgroup{background:#1a1a2e;color:#7c6fff;font-weight:700;font-style:normal;padding:8px 0}
select option{background:#0a0a14;color:#e0e0f0;padding:4px 8px}
.mtextarea{min-height:120px;resize:vertical}
.mbtns{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
.mbtn{flex:1;padding:10px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;min-width:80px}
.mbtn.primary{background:#7c6fff;color:#fff}
.mbtn.secondary{background:#1a1a2e;color:#8899bb;border:1px solid #ffffff22}
.mbtn.danger{background:#ff446622;color:#ff4466;border:1px solid #ff446644}
.mbtn.copy{background:#00cfff22;color:#00cfff;border:1px solid #00cfff44}
.export-modal .mbox{width:500px}
.export-options{display:flex;flex-direction:column;gap:10px;margin:16px 0}
.export-opt{display:flex;align-items:center;gap:10px;padding:12px;background:#0a0a14;border:1px solid #ffffff11;border-radius:8px;cursor:pointer}
.export-opt:hover{border-color:#7c6fff44}
.export-opt input{accent-color:#7c6fff}


/* Mobile Responsive */
@media (max-width: 768px) {
  header{padding:10px 14px;flex-wrap:wrap;gap:8px}
  .logo{font-size:16px}
  .sub{display:none}
  .mode-btns{gap:4px}
  .mode-btn{padding:8px 12px;font-size:11px}
  .sessions-btn{padding:6px 10px}
  
  .main{flex-direction:column;position:relative}
  
  .sidebar{position:fixed;top:0;left:0;width:85vw;max-width:320px;height:100vh;z-index:80;transform:translateX(-100%);transition:transform 0.25s ease;border-right:1px solid #7c6fff44;background:#0a0a14}
  .sidebar.open{transform:translateX(0)}
  .sidebar-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:79}
  .sidebar-overlay.open{display:block}
  
  .hamburger{display:flex !important;background:none;border:none;font-size:24px;cursor:pointer;padding:4px;color:#7c6fff}
  
  .chat{width:100%}
  .empty{font-size:13px;padding:40px 20px}
  .cheader{padding:10px 14px}
  .cheader-name{font-size:15px}
  .cheader-btns{gap:4px}
  .cbtn{padding:6px 10px}
  .msgs{padding:12px 14px}
  .msg{max-width:88%}
  .bubble{padding:10px 12px;font-size:14px}
  .seeds{padding:0;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;border-top:none;max-height:0;overflow:hidden;transition:max-height 0.2s}
  .seeds.expanded{max-height:120px;padding:8px 14px;overflow-x:auto;border-top:1px solid #ffffff08}
  .seeds::-webkit-scrollbar{display:none}
  .sbtn{white-space:nowrap;flex-shrink:0;padding:8px 14px;font-size:12px}
  .seeds-toggle{display:block !important}
  .sbtn{padding:8px 14px;font-size:12px}
  .iarea{padding:10px 14px}
  .iarea textarea{padding:12px;font-size:15px}
  .sendbtn{padding:12px 18px;font-size:14px}
  
  .modal{padding:20px 10px}
  .mbox{padding:18px}
  .mtitle{font-size:16px}
  .mbtns{flex-wrap:wrap}
  .mbtn{min-width:45%}
  
  .sessions-panel{left:10px;right:10px;width:auto;top:50px}
  
  .history-btn{display:flex !important}
  .history-panel{left:0;right:0;width:100%;max-width:100%;border-radius:0;top:auto;bottom:0;max-height:80vh}
  
  .pcard{padding:12px}
  .pavatar{font-size:28px}
  .pname{font-size:14px}
  .ptag{font-size:11px}
  .pcheck{width:22px;height:22px}
}

/* Hamburger - hidden on desktop */
.hamburger{display:none}

/* History Panel */
.history-btn{display:none;background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:6px 10px;border-radius:4px;font-size:11px;cursor:pointer;margin-left:auto}
.history-panel{display:none;position:fixed;top:60px;right:10px;width:360px;max-height:75vh;background:#111128;border:1px solid #7c6fff44;border-radius:12px;z-index:60;overflow:hidden;flex-direction:column}
.history-panel.open{display:flex}
.history-header{padding:12px 16px;border-bottom:1px solid #ffffff11;display:flex;justify-content:space-between;align-items:center}
.history-title{font-size:14px;font-weight:700;color:#fff}
.history-list{flex:1;overflow-y:auto;padding:8px}
.history-item{padding:12px;background:#0a0a14;border:1px solid #ffffff11;border-radius:8px;margin-bottom:8px;cursor:pointer}
.history-item:hover{border-color:#7c6fff44}
.history-item.active{border-color:#7c6fff;background:#7c6fff11}
.history-name{font-size:13px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px}
.history-name .av{font-size:16px}
.history-meta{font-size:10px;color:#556677;margin-top:4px}
.history-preview{font-size:11px;color:#8899bb;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history-actions{display:flex;gap:6px;margin-top:8px}
.history-actions button{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:4px 10px;border-radius:4px;font-size:10px;cursor:pointer}
.history-actions button:hover{border-color:#7c6fff44;color:#7c6fff}
.history-actions button.danger:hover{border-color:#ff446644;color:#ff4466}
.new-chat-btn{margin:12px;background:#7c6fff;color:#fff;border:none;padding:12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<header>
  <div><div class="logo">Identity<span>Channeler</span>Bot</div><div class="sub">Channel any identity — real, fictional, AI, or NHI</div></div>
  <button class="hamburger" onclick="toggleSidebar()">☰</button>
  <div class="mode-btns">
    <button class="mode-btn active" id="mode-solo" onclick="setMode('solo')">Solo Chat</button>
    <button class="mode-btn" id="mode-group" onclick="setMode('group')">Group Chat</button>
    <button class="sessions-btn" onclick="toggleSessions()">📁</button>
    <button class="sessions-btn" id="log-toggle" onclick="toggleLogging()" title="Toggle conversation logging">📝</button>
    <a class="sessions-btn" href="/gallery" target="_blank" title="Image Gallery">🖼️</a>
    <button class="history-btn" onclick="toggleHistory()">💬 Chats</button>
  </div>
</header>
<div class="main">
  <div class="sidebar" id="sidebar">
    <div class="stitle"><span>Personas</span><button class="newbtn" onclick="openNew()">+ New</button></div>
    <div class="model-switcher"><label>All →</label><select id="bulk-model">
      <optgroup label="🖥️ LOCAL (Free)">
        <option value="ollama/mistral-nemo:12b">mistral-nemo:12b</option>
        <option value="ollama/llama3.1:8b">llama3.1:8b</option>
        <option value="ollama/llama3.3:70b">llama3.3:70b</option>
        <option value="ollama/qwen3:30b-a3b">qwen3:30b-a3b</option>
        <option value="ollama/dolphin-llama3:8b">dolphin-llama3:8b</option>
        <option value="ollama/dolphin-llama3:70b">dolphin-llama3:70b</option>
      </optgroup>
      <optgroup label="🔮 Anthropic">
        <option value="anthropic/claude-opus-4-5">claude-opus-4-5</option>
        <option value="anthropic/claude-sonnet-4-6">claude-sonnet-4-6</option>
      </optgroup>
      <optgroup label="🌐 OpenRouter">
        <option value="openrouter/x-ai/grok-4.1-fast">grok-4.1-fast</option>
        <option value="openrouter/x-ai/grok-3">grok-3</option>
      </optgroup>
    </select><button onclick="setAllModels()">Set All</button></div>
    <div class="group-bar"><span id="group-count">0 selected</span><button onclick="startGroup()">Start Group Chat</button></div>
    <div class="plist" id="plist">${cards}</div>
  </div>
  <div class="chat">
    <div class="empty" id="empty">← Select a persona for solo chat<br>or switch to Group mode</div>
    <div id="chatwrap">
      <div class="cheader" id="cheader"></div>
      <div class="msgs" id="msgs"></div>
      <button class="seeds-toggle" id="seeds-toggle" onclick="toggleSeeds()">💡 Suggestions</button>
      <div class="seeds" id="seeds"></div>
      <div class="iarea"><textarea id="input" placeholder="Ask something..." rows="2"></textarea><button class="sendbtn" id="sendbtn">Send</button></div>
    </div>
  </div>
</div>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
<div class="history-panel" id="history-panel">
  <div class="history-header"><span class="history-title">💬 Chat History</span><button class="gbtn" onclick="toggleHistory()" style="opacity:1">✕</button></div>
  <div class="history-list" id="history-list"></div>
  <button class="new-chat-btn" onclick="newChat()">+ New Chat</button>
</div>
<div class="sessions-panel" id="sessions-panel">
  <div class="sessions-header"><span class="sessions-title">Saved Sessions</span><button class="gbtn" onclick="toggleSessions()" style="opacity:1">✕</button></div>
  <div class="sessions-list" id="sessions-list"></div>
  <div class="save-session-row"><input id="session-name" placeholder="Name this session..."><button onclick="saveCurrentSession()">Save</button></div>
</div>
<div class="modal" id="modal">
  <div class="mbox">
    <div class="mtitle"><span id="mtitle">Edit Persona</span><button class="gbtn" onclick="closeModal()" style="opacity:1;font-size:18px">✕</button></div>
    <div class="mrow2">
      <div class="mrow"><label class="mlabel">ID (no spaces)</label><input class="minput" id="mid" placeholder="my-persona"></div>
      <div class="mrow"><label class="mlabel">Avatar (emoji)</label><input class="minput" id="mavatar" placeholder="🤖" style="width:80px"></div>
    </div>
    <div class="mrow"><label class="mlabel">Name</label><input class="minput" id="mname" placeholder="Persona Name"></div>
    <div class="mrow"><label class="mlabel">Tagline</label><input class="minput" id="mtagline" placeholder="A brief description"></div>
    <div class="mrow2">
      <div class="mrow"><label class="mlabel">Type</label><select class="msel" id="mtype"></select></div>
      <div class="mrow"><label class="mlabel">LLM Model</label><select class="msel" id="mmodel"></select></div>
    </div>
    <div class="mrow"><label class="mlabel">System Prompt</label><textarea class="mtextarea" id="mprompt" placeholder="You are channeling..."></textarea></div>
    <div class="mrow"><label class="mlabel">Seed Questions (one per line)</label><textarea class="mtextarea" id="mseeds" style="min-height:80px" placeholder="What is your story?"></textarea></div>
    <div class="mbtns" id="mbtns"></div>
  </div>
</div>
<div class="modal export-modal" id="export-modal">
  <div class="mbox">
    <div class="mtitle"><span>Export Transcript</span><button class="gbtn" onclick="closeExport()" style="opacity:1;font-size:18px">✕</button></div>
    <div class="export-options">
      <label class="export-opt"><input type="radio" name="expfmt" value="txt" checked> Plain Text (.txt)</label>
      <label class="export-opt"><input type="radio" name="expfmt" value="md"> Markdown (.md)</label>
      <label class="export-opt"><input type="radio" name="expfmt" value="json"> JSON (.json)</label>
      <label class="export-opt"><input type="radio" name="expfmt" value="server"> Save to Server</label>
    </div>
    <div class="mbtns">
      <button class="mbtn secondary" onclick="closeExport()">Cancel</button>
      <button class="mbtn primary" onclick="doExport()">Export</button>
    </div>
  </div>
</div>
<div class="modal memory-modal" id="memory-modal">
  <div class="mbox">
    <div class="mtitle"><span>💾 Save to Memory</span><button class="gbtn" onclick="closeMemory()" style="opacity:1;font-size:18px">✕</button></div>
    <div class="mrow">
      <label class="mlabel">Memory Type</label>
      <div class="export-options" style="margin:0">
        <label class="export-opt"><input type="radio" name="memmode" value="detailed" checked> <strong>Detailed</strong> — Full conversation saved</label>
        <label class="export-opt"><input type="radio" name="memmode" value="compact"> <strong>Compact</strong> — Summary only (write below)</label>
      </div>
    </div>
    <div class="mrow">
      <label class="mlabel">Summary / Key Points (required for compact, optional for detailed)</label>
      <textarea class="mtextarea" id="memory-summary" placeholder="What should the persona remember from this conversation? Key facts, decisions, insights..."></textarea>
    </div>
    <div class="mrow" id="memory-count" style="font-size:11px;color:#556677"></div>
    <div class="mbtns">
      <button class="mbtn secondary" onclick="closeMemory()">Cancel</button>
      <button class="mbtn" onclick="viewMemories()" style="background:#00cfff22;color:#00cfff;border:1px solid #00cfff44">📚 View Memories</button>
      <button class="mbtn primary" onclick="saveMemory()">💾 Save Memory</button>
    </div>
  </div>
</div>
<div class="modal memories-list-modal" id="memories-list-modal">
  <div class="mbox" style="max-height:80vh;overflow-y:auto">
    <div class="mtitle"><span>📚 Persona Memories</span><button class="gbtn" onclick="closeMemoriesList()" style="opacity:1;font-size:18px">✕</button></div>
    <div class="mrow">
      <input class="minput" id="memory-search" placeholder="Search memories..." oninput="searchMemories()">
    </div>
    <div id="memories-list" style="max-height:50vh;overflow-y:auto"></div>
    <div class="mbtns">
      <button class="mbtn secondary" onclick="closeMemoriesList()">Close</button>
    </div>
  </div>
</div>
<script>
var PERSONAS = JSON.parse('${personasJS}');
var MODELS = ${modelsJS};
var TYPES = ${typesJS};
var mode = 'solo';
var current = null;
var groupIds = [];
var chatHistory = [];
var fullTranscript = [];
var savedChats = JSON.parse(localStorage.getItem('channeler_chats')||'{}');
var editingId = null;
var isNew = false;

function setMode(m) {
  mode = m;
  document.getElementById('mode-solo').classList.toggle('active', m==='solo');
  document.getElementById('mode-group').classList.toggle('active', m==='group');
  document.getElementById('sidebar').classList.toggle('group-mode', m==='group');
  if (m==='solo') {
    groupIds = [];
    document.querySelectorAll('.pcheck').forEach(function(c){c.checked=false;});
    document.querySelectorAll('.pcard').forEach(function(c){c.classList.remove('ingroup');c.onclick=function(){pick(c.dataset.id);};});
    updateGroupCount();
  } else {
    document.getElementById('chatwrap').style.display = 'none';
    document.getElementById('empty').style.display = 'flex';
    document.getElementById('empty').innerHTML = 'Select 2-5 personas for group chat<br>then click Start Group Chat';
    document.querySelectorAll('.pcard').forEach(function(c){c.onclick=null;});
  }
}

function toggleGroup(id) {
  var idx = groupIds.indexOf(id);
  if (idx >= 0) {
    groupIds.splice(idx, 1);
    document.getElementById('pc-'+id).classList.remove('ingroup');
  } else if (groupIds.length < 5) {
    groupIds.push(id);
    document.getElementById('pc-'+id).classList.add('ingroup');
  } else {
    document.querySelector('#pc-'+id+' .pcheck').checked = false;
    alert('Max 5 personas in group');
  }
  updateGroupCount();
}

function updateGroupCount() {
  document.getElementById('group-count').textContent = groupIds.length + ' selected';
}

function startGroup() {
  if (groupIds.length < 2) { alert('Select at least 2 personas'); return; }
  current = null;
  chatHistory = [];
  fullTranscript = [];
  var participants = groupIds.map(function(id){return PERSONAS.find(function(p){return p.id===id;});});
  document.getElementById('empty').style.display = 'none';
  document.getElementById('chatwrap').style.cssText = 'display:flex;flex:1;flex-direction:column;overflow:hidden;';
  var avatars = participants.map(function(p){return '<span title="'+p.name+'">'+p.avatar+'</span>';}).join('');
  var names = participants.map(function(p){return p.name;}).join(', ');
  document.getElementById('cheader').innerHTML = '<div class="cheader-participants">'+avatars+'</div><div><div class="cheader-name">Group: '+names+'</div><div class="cheader-tag">'+participants.length+' participants</div></div><div class="cheader-btns"><button class="cbtn" onclick="openMemory()">💾 Memory</button><button class="cbtn" onclick="openExport()">Export</button><button class="cbtn" onclick="clearChat()">Clear</button></div>';
  document.getElementById('msgs').innerHTML = '';
  document.getElementById('seeds').innerHTML = '';
  document.getElementById('input').focus();
}

function pick(id) {
  if (mode === 'group') return;
  current = PERSONAS.find(function(p){return p.id===id;});
  if (!current) return;
  groupIds = [];
  chatHistory = [];
  fullTranscript = [];
  document.querySelectorAll('.pcard').forEach(function(c){c.classList.remove('active');});
  document.getElementById('pc-'+id).classList.add('active');
  document.getElementById('empty').style.display = 'none';
  document.getElementById('chatwrap').style.cssText = 'display:flex;flex:1;flex-direction:column;overflow:hidden;';
  document.getElementById('cheader').innerHTML = '<div class="cheader-av">'+current.avatar+'</div><div><div class="cheader-name">'+current.name+'</div><div class="cheader-tag">'+current.tagline+'</div></div><div class="cheader-btns"><button class="cbtn" onclick="openMemory()">💾 Memory</button><button class="cbtn" onclick="openExport()">Export</button><button class="cbtn" onclick="clearChat()">Clear</button></div>';
  document.getElementById('msgs').innerHTML = '';
  document.getElementById('seeds').innerHTML = '';
  if (current.seed_questions) {
    for (var j=0;j<current.seed_questions.length;j++) {
      var q = current.seed_questions[j];
      var btn = document.createElement('button');
      btn.className = 'sbtn';
      btn.textContent = q;
      btn.onclick = (function(qq){return function(){doSeed(qq);};})(q);
      document.getElementById('seeds').appendChild(btn);
    }
  }
  loadChat();
  document.getElementById('input').focus();
}

function refreshModelSelect() {
  var sel = document.getElementById('e-llm');
  if (!sel) return;
  sel.innerHTML = MODELS.map(function(m){
    return '<option value="'+m+'">'+m.split('/').slice(-1)[0]+'</option>';
  }).join('');
}

function openEdit(id) {
  isNew = false;
  editingId = id;
  var p = PERSONAS.find(function(x){return x.id===id;});
  document.getElementById('mtitle').textContent = 'Edit ' + p.name;
  document.getElementById('mid').value = p.id;
  document.getElementById('mid').disabled = true;
  document.getElementById('mavatar').value = p.avatar;
  document.getElementById('mname').value = p.name;
  document.getElementById('mtagline').value = p.tagline;
  fillSelect('mtype', TYPES, p.type);
  fillSelect('mmodel', MODELS, p.llm);
  document.getElementById('mprompt').value = p.system_prompt || '';
  document.getElementById('mseeds').value = (p.seed_questions||[]).join('\\n');
  document.getElementById('mbtns').innerHTML = '<button class="mbtn secondary" onclick="closeModal()">Cancel</button><button class="mbtn copy" onclick="copyPersona()">Copy</button><button class="mbtn danger" onclick="deletePersona()">Delete</button><button class="mbtn primary" onclick="savePersona()">Save</button>';
  document.getElementById('modal').classList.add('open');
}

function openNew() {
  isNew = true;
  editingId = null;
  document.getElementById('mtitle').textContent = 'New Persona';
  document.getElementById('mid').value = '';
  document.getElementById('mid').disabled = false;
  document.getElementById('mavatar').value = '🤖';
  document.getElementById('mname').value = '';
  document.getElementById('mtagline').value = '';
  fillSelect('mtype', TYPES, 'ai');
  fillSelect('mmodel', MODELS, 'anthropic/claude-opus-4-5');
  document.getElementById('mprompt').value = 'You are channeling [NAME]...\\n\\nSpeak AS [NAME]. First person. Do not break character.';
  document.getElementById('mseeds').value = '';
  document.getElementById('mbtns').innerHTML = '<button class="mbtn secondary" onclick="closeModal()">Cancel</button><button class="mbtn primary" onclick="savePersona()">Create</button>';
  document.getElementById('modal').classList.add('open');
}

function fillSelect(id, opts, val) {
  // Group models by provider for better UX
  var local = opts.filter(function(o){return o.startsWith('ollama/');});
  var anthropic = opts.filter(function(o){return o.startsWith('anthropic/');});
  var openrouter = opts.filter(function(o){return o.startsWith('openrouter/');});
  var other = opts.filter(function(o){return !o.startsWith('ollama/') && !o.startsWith('anthropic/') && !o.startsWith('openrouter/');});
  
  function renderOpts(arr) {
    return arr.map(function(o){
      var label = o.split('/').slice(-1)[0];
      return '<option value="'+o+'"'+(o===val?' selected':'')+'>'+label+'</option>';
    }).join('');
  }
  
  var html = '';
  if (local.length) html += '<optgroup label="🖥️ LOCAL (Free)">' + renderOpts(local) + '</optgroup>';
  if (anthropic.length) html += '<optgroup label="🔮 Anthropic">' + renderOpts(anthropic) + '</optgroup>';
  if (openrouter.length) html += '<optgroup label="🌐 OpenRouter">' + renderOpts(openrouter) + '</optgroup>';
  if (other.length) html += '<optgroup label="Other">' + renderOpts(other) + '</optgroup>';
  
  document.getElementById(id).innerHTML = html;
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }
function openExport() { document.getElementById('export-modal').classList.add('open'); }
function closeExport() { document.getElementById('export-modal').classList.remove('open'); }

// Memory functions
function openMemory() {
  if (!current && groupIds.length === 0) { alert('No active conversation'); return; }
  document.getElementById('memory-summary').value = '';
  var count = fullTranscript.filter(function(m){return m.role==='user'||m.role==='assistant';}).length;
  document.getElementById('memory-count').textContent = 'This conversation has ' + count + ' messages.';
  document.getElementById('memory-modal').classList.add('open');
}
function closeMemory() { document.getElementById('memory-modal').classList.remove('open'); }

async function saveMemory() {
  var mode = document.querySelector('input[name="memmode"]:checked').value;
  var summary = document.getElementById('memory-summary').value.trim();
  
  if (mode === 'compact' && !summary) {
    alert('Please write a summary for compact memory mode.');
    return;
  }
  
  var personaId = current ? current.id : groupIds[0];
  var conversation = fullTranscript.filter(function(m){return m.role==='user'||m.role==='assistant';});
  
  try {
    var r = await fetch('/api/memories/save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        persona_id: personaId,
        mode: mode,
        summary: summary || null,
        conversation: conversation
      })
    });
    var d = await r.json();
    if (d.ok) {
      alert('Memory saved! ID: ' + d.memory_id);
      closeMemory();
    } else {
      alert('Error: ' + d.error);
    }
  } catch(e) {
    alert('Error saving memory: ' + e.message);
  }
}

function viewMemories() {
  closeMemory();
  var personaId = current ? current.id : groupIds[0];
  loadMemoriesList(personaId);
  document.getElementById('memories-list-modal').classList.add('open');
}

function closeMemoriesList() { document.getElementById('memories-list-modal').classList.remove('open'); }

async function loadMemoriesList(personaId) {
  try {
    var r = await fetch('/api/memories/' + personaId);
    var d = await r.json();
    var list = document.getElementById('memories-list');
    if (!d.ok || d.memories.length === 0) {
      list.innerHTML = '<div style="color:#556677;padding:20px;text-align:center">No memories saved yet for this persona.</div>';
      return;
    }
    list.innerHTML = d.memories.reverse().map(function(m) {
      var date = new Date(m.timestamp).toLocaleDateString() + ' ' + new Date(m.timestamp).toLocaleTimeString();
      var badge = m.mode === 'compact' ? '<span style="background:#7c6fff33;color:#7c6fff;padding:2px 6px;border-radius:4px;font-size:9px">COMPACT</span>' : '<span style="background:#00cfff33;color:#00cfff;padding:2px 6px;border-radius:4px;font-size:9px">DETAILED</span>';
      return '<div style="background:#1a1a2e;border:1px solid #ffffff11;border-radius:8px;padding:12px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<span style="font-size:11px;color:#556677">' + date + '</span>' + badge +
        '</div>' +
        '<div style="font-size:13px;color:#e0e0f0">' + (m.summary || '<em style="color:#556677">No summary</em>') + '</div>' +
        '<div style="font-size:10px;color:#445566;margin-top:6px">' + m.message_count + ' messages</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    document.getElementById('memories-list').innerHTML = '<div style="color:#ff4466">Error loading memories: ' + e.message + '</div>';
  }
}

async function searchMemories() {
  var personaId = current ? current.id : groupIds[0];
  var query = document.getElementById('memory-search').value.trim();
  if (!query) { loadMemoriesList(personaId); return; }
  try {
    var r = await fetch('/api/memories/' + personaId + '/search?q=' + encodeURIComponent(query));
    var d = await r.json();
    var list = document.getElementById('memories-list');
    if (!d.ok || d.results.length === 0) {
      list.innerHTML = '<div style="color:#556677;padding:20px;text-align:center">No memories match "' + query + '"</div>';
      return;
    }
    list.innerHTML = d.results.map(function(m) {
      var date = new Date(m.timestamp).toLocaleDateString();
      return '<div style="background:#1a1a2e;border:1px solid #7c6fff44;border-radius:8px;padding:12px;margin-bottom:8px">' +
        '<div style="font-size:11px;color:#556677;margin-bottom:6px">' + date + ' · ' + m.message_count + ' msgs</div>' +
        '<div style="font-size:13px;color:#e0e0f0">' + (m.summary || '<em>No summary</em>') + '</div>' +
        (m.matches && m.matches.length > 0 ? '<div style="margin-top:8px;padding:8px;background:#0a0a14;border-radius:4px;font-size:11px;color:#8899bb">' + 
          m.matches.map(function(msg){return '<div style="margin-bottom:4px">...' + msg.content.slice(0,100) + '...</div>';}).join('') + 
        '</div>' : '') +
      '</div>';
    }).join('');
  } catch(e) {
    document.getElementById('memories-list').innerHTML = '<div style="color:#ff4466">Search error: ' + e.message + '</div>';
  }
}

async function savePersona() {
  var data = {
    id: document.getElementById('mid').value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-'),
    avatar: document.getElementById('mavatar').value.trim() || '🤖',
    name: document.getElementById('mname').value.trim(),
    tagline: document.getElementById('mtagline').value.trim(),
    type: document.getElementById('mtype').value,
    llm: document.getElementById('mmodel').value,
    system_prompt: document.getElementById('mprompt').value,
    seed_questions: document.getElementById('mseeds').value.split('\\n').filter(function(x){return x.trim();})
  };
  if (!data.id || !data.name) { alert('ID and Name required'); return; }
  var url = isNew ? '/api/persona/create' : '/api/persona/update';
  var r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  var d = await r.json();
  if (d.ok) location.reload();
  else alert('Error: ' + d.error);
}

async function copyPersona() {
  var newId = prompt('New ID for copy:', editingId + '-copy');
  if (!newId) return;
  var data = {
    id: newId.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-'),
    avatar: document.getElementById('mavatar').value.trim(),
    name: document.getElementById('mname').value.trim() + ' (Copy)',
    tagline: document.getElementById('mtagline').value.trim(),
    type: document.getElementById('mtype').value,
    llm: document.getElementById('mmodel').value,
    system_prompt: document.getElementById('mprompt').value,
    seed_questions: document.getElementById('mseeds').value.split('\\n').filter(function(x){return x.trim();})
  };
  var r = await fetch('/api/persona/create', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  var d = await r.json();
  if (d.ok) location.reload();
  else alert('Error: ' + d.error);
}

async function deletePersona() {
  if (!confirm('Delete ' + editingId + '?')) return;
  var r = await fetch('/api/persona/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:editingId})});
  var d = await r.json();
  if (d.ok) location.reload();
  else alert('Error: ' + d.error);
}

function doSeed(q) { document.getElementById('input').value = q; doSend(); }



function addMsgNoImage(role, text, name, av, personaId, meta) {
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  var nameEl = document.createElement('div');
  nameEl.className = 'mname';
  nameEl.textContent = name || role;
  var inner = document.createElement('div');
  inner.appendChild(nameEl);
  inner.appendChild(bubble);
  // Add metadata line if present
  if (meta && role === 'assistant') {
    var metaEl = document.createElement('div');
    metaEl.className = 'msg-meta';
    var modelName = (meta.model || '').split('/').pop();
    var secs = meta.latency_ms ? (meta.latency_ms / 1000).toFixed(1) : '?';
    metaEl.textContent = '⚡ ' + modelName + ' · ' + (meta.tokens || '?') + ' tokens · ' + secs + 's';
    inner.appendChild(metaEl);
  }
  var avEl = document.createElement('div');
  avEl.className = 'msg-av';
  avEl.textContent = av || '?';
  el.appendChild(avEl);
  el.appendChild(inner);
  document.getElementById('msgs').appendChild(el);
  document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
  fullTranscript.push({role:role, name:name, avatar:av, content:text, persona_id:personaId, timestamp:new Date().toISOString()});
  return el;
}

function addMsg(role, text, name, av, personaId, meta) {
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  
  // Check for image generation tag
  var imgMatch = text.match(/\\[GENERATE_IMAGE:\\s*(.+?)\\]/);
  var displayText = text.replace(/\\[GENERATE_IMAGE:\\s*.+?\\]/g, '').trim();
  
  bubble.textContent = displayText || (imgMatch ? '🎨 Generating image...' : text);
  var nameEl = document.createElement('div');
  nameEl.className = 'mname';
  nameEl.textContent = name || role;
  var inner = document.createElement('div');
  inner.appendChild(nameEl);
  inner.appendChild(bubble);
  // Add metadata line if present
  if (meta && role === 'assistant') {
    var metaEl = document.createElement('div');
    metaEl.className = 'msg-meta';
    var modelName = (meta.model || '').split('/').pop();
    var secs = meta.latency_ms ? (meta.latency_ms / 1000).toFixed(1) : '?';
    metaEl.textContent = '⚡ ' + modelName + ' · ' + (meta.tokens || '?') + ' tokens · ' + secs + 's';
    inner.appendChild(metaEl);
  }
  var avEl = document.createElement('div');
  avEl.className = 'msg-av';
  avEl.textContent = av || '?';
  el.appendChild(avEl);
  el.appendChild(inner);
  document.getElementById('msgs').appendChild(el);
  document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
  fullTranscript.push({role:role, name:name, avatar:av, content:text, persona_id:personaId, timestamp:new Date().toISOString()});
  
  // If image tag found, generate image
  if (imgMatch && imgMatch[1] && role === 'assistant' && !text.includes('channeling ')) {
    generateImageInChat(imgMatch[1], el);
  }
  
  return el;
}

function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}

async function generateImageInChat(prompt, msgEl) {
  if (!prompt || typeof prompt !== 'string') { console.log('No valid prompt for image gen'); return; }
  try {
  var genDiv = document.createElement('div');
  genDiv.className = 'generating';
  genDiv.textContent = '🎨 Generating image: ' + (prompt || '').slice(0,50) + '...';
  msgEl.querySelector('.bubble').appendChild(genDiv);
  
  try {
    var r = await fetch('/api/image/generate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      prompt: prompt,
      persona_id: current ? current.id : (groupIds[0] || 'unknown'),
      persona_name: current ? current.name : 'Group Chat',
      persona_avatar: current ? current.avatar : '👥',
      model: current ? current.llm : 'unknown'
    })});
    var d = await r.json();
    genDiv.remove();
    
    if (d.ok) {
      var imgWrap = document.createElement('div');
      var img = document.createElement('img');
      img.src = d.url;
      img.className = 'msg-img';
      img.onclick = function(){openLightbox(d.url);};
      imgWrap.appendChild(img);
      
      var actions = document.createElement('div');
      actions.className = 'img-actions';
      var archBtn = document.createElement('button');
      archBtn.className = 'img-btn';
      archBtn.textContent = 'Archive';
      archBtn.onclick = function(){ archiveImg(this, d.filename); };
      var delBtn = document.createElement('button');
      delBtn.className = 'img-btn danger';
      delBtn.textContent = 'Delete';
      delBtn.onclick = function(){ deleteImg(this, d.filename); };
      actions.appendChild(archBtn);
      actions.appendChild(delBtn);
      imgWrap.appendChild(actions);
      
      msgEl.querySelector('.bubble').appendChild(imgWrap);
      fullTranscript.push({role:'image', filename:d.filename, url:d.url, prompt:prompt, timestamp:new Date().toISOString()});
      saveChat();
    } else {
      var err = document.createElement('div');
      err.style.color = '#ff4466';
      err.textContent = 'Image error: ' + d.error;
      msgEl.querySelector('.bubble').appendChild(err);
    }
  } catch(e) {
    if (genDiv && genDiv.parentNode) genDiv.remove();
    console.error('Image gen error:', e);
  }
  } catch(outerE) { console.error('Image gen outer error:', outerE); }
}

async function archiveImg(btn, filename) {
  var r = await fetch('/api/image/archive', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:filename})});
  var d = await r.json();
  if (d.ok) {
    btn.parentElement.parentElement.querySelector('img').style.opacity = '0.3';
    btn.textContent = 'Archived';
    btn.disabled = true;
  }
}

async function deleteImg(btn, filename) {
  if (!confirm('Delete this image?')) return;
  var r = await fetch('/api/image/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:filename})});
  var d = await r.json();
  if (d.ok) {
    btn.parentElement.parentElement.remove();
  }
}

// Modify addMsg to detect image generation requests
var origAddMsg = addMsg;


function saveChat() {
  var key = mode==='group' ? 'group-'+groupIds.sort().join('-') : current?.id;
  if (!key || fullTranscript.length===0) return;
  savedChats[key] = fullTranscript;
  localStorage.setItem('channeler_chats', JSON.stringify(savedChats));
}

function loadChat() {
  var key = current?.id;
  if (!key || !savedChats[key]) return;
  fullTranscript = savedChats[key];
  chatHistory = fullTranscript.filter(function(m){return m.role==='user'||m.role==='assistant';}).map(function(m){return {role:m.role==='user'?'user':'assistant',content:m.content};});
  for (var i=0;i<fullTranscript.length;i++) {
    var m = fullTranscript[i];
    addMsgSilent(m.role, m.content, m.name, m.avatar);
  }
}

function addMsgSilent(role, text, name, av) {
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  var nameEl = document.createElement('div');
  nameEl.className = 'mname';
  nameEl.textContent = name || role;
  var inner = document.createElement('div');
  inner.appendChild(nameEl);
  inner.appendChild(bubble);
  var avEl = document.createElement('div');
  avEl.className = 'msg-av';
  avEl.textContent = av || '?';
  el.appendChild(avEl);
  el.appendChild(inner);
  document.getElementById('msgs').appendChild(el);
}

function clearChat() {
  var key = mode==='group' ? 'group-'+groupIds.sort().join('-') : current?.id;
  chatHistory = [];
  fullTranscript = [];
  if (key) { delete savedChats[key]; localStorage.setItem('channeler_chats', JSON.stringify(savedChats)); }
  document.getElementById('msgs').innerHTML = '';
}

async function doExport() {
  var fmt = document.querySelector('input[name="expfmt"]:checked').value;
  var title = mode==='group' ? 'Group Chat' : (current?.name || 'Chat');
  var filename = (mode==='group' ? 'group-'+Date.now() : current?.id) + '-' + new Date().toISOString().slice(0,10);
  var content;
  if (fmt === 'json') {
    content = JSON.stringify({title:title, mode:mode, participants: mode==='group'?groupIds:[current?.id], transcript:fullTranscript}, null, 2);
    download(filename+'.json', content, 'application/json');
  } else if (fmt === 'md') {
    content = '# '+title+'\\n\\n';
    content += fullTranscript.map(function(m){return '**'+m.name+'** ('+m.timestamp.slice(11,19)+')\\n\\n'+m.content;}).join('\\n\\n---\\n\\n');
    download(filename+'.md', content, 'text/markdown');
  } else if (fmt === 'txt') {
    content = fullTranscript.map(function(m){return m.name+': '+m.content;}).join('\\n\\n');
    download(filename+'.txt', content, 'text/plain');
  } else if (fmt === 'server') {
    var r = await fetch('/api/transcript/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:filename, title:title, mode:mode, participants:mode==='group'?groupIds:[current?.id], transcript:fullTranscript})});
    var d = await r.json();
    if (d.ok) alert('Saved to server: '+d.path);
    else alert('Error: '+d.error);
  }
  closeExport();
}

function download(filename, content, type) {
  var blob = new Blob([content], {type:type});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

async function doSend() {
  var inp = document.getElementById('input');
  var txt = inp.value.trim();
  if (!txt) return;
  if (mode==='solo' && !current) return;
  if (mode==='group' && groupIds.length < 2) return;
  inp.value = '';
  var btn = document.getElementById('sendbtn');
  btn.disabled = true;

  addMsg('user', txt, 'You', '🧠', null);
  chatHistory.push({role:'user', content:txt});

  if (mode === 'solo') {
    var typing = addMsg('assistant', 'channeling '+current.name+'...', current.name, current.avatar, current.id);
    typing.querySelector('.bubble').classList.add('typing');
    try {
      var ctrl = new AbortController();
    var timeout = setTimeout(function(){ctrl.abort();}, 120000);
    var r = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persona_id:current.id, messages:chatHistory}), signal:ctrl.signal});
    clearTimeout(timeout);
      var d = await r.json();
      typing.remove(); fullTranscript.pop();
      console.log('API response for', current.name, ':', JSON.stringify(d).slice(0,200));
        var reply = (d.ok && d.response) ? d.response : (d.error ? 'Error: ' + d.error : 'No response received');
      chatHistory.push({role:'assistant', content:reply});
      var meta = d.ok ? {model: d.model, latency_ms: d.latency_ms, tokens: d.tokens_estimate} : null;
      addMsg('assistant', reply, current.name, current.avatar, current.id, meta);
      saveChat();
    } catch(e) {
      typing.remove(); fullTranscript.pop();
      console.error('Solo chat error:', e);
      addMsg('assistant', 'Error: ' + (e.name || 'Unknown') + ' - ' + (e.message || String(e)), 'Error', '⚠', null);
    }
  } else {
    // Group chat - each bot responds in sequence
    for (var i=0; i<groupIds.length; i++) {
      var gid = groupIds[i];
      var persona = PERSONAS.find(function(p){return p.id===gid;});
      if (!persona) { console.error('Persona not found:', gid); continue; }
      console.log('Group chat: querying', persona.name, '('+i+'/'+groupIds.length+')');
      var typingEl = document.createElement('div');
      typingEl.className = 'msg assistant';
      typingEl.innerHTML = '<div class="msg-av">'+persona.avatar+'</div><div><div class="mname">'+persona.name+'</div><div class="bubble typing">channeling '+persona.name+'...</div></div>';
      document.getElementById('msgs').appendChild(typingEl);
      document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
      try {
        var gctrl = new AbortController();
        var gtimeout = setTimeout(function(){gctrl.abort();}, 120000);
        var r = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persona_id:persona.id, messages:chatHistory}), signal:gctrl.signal});
        clearTimeout(gtimeout);
        var d = await r.json();
        typingEl.remove();
        var reply = d.ok ? d.response : 'Error: ' + d.error;
        // Add as user message so next bot sees it as context, not their own response
        chatHistory.push({role:'user', content:'[System: '+persona.name+' said]: '+reply});
        var meta = d.ok ? {model: d.model, latency_ms: d.latency_ms, tokens: d.tokens_estimate} : null;
        addMsgNoImage('assistant', reply, persona.name, persona.avatar, persona.id, meta);
        console.log('Group chat: got response from', persona.name);
      } catch(e) {
        console.error('Group chat error for', persona.name, ':', e.name, e.message);
        typingEl.remove();
        addMsgNoImage('assistant', 'Error: ' + e.name + ' — ' + e.message, persona.name, persona.avatar, persona.id);
      }
    }
    saveChat();
  }
  btn.disabled = false;
  inp.focus();
}

document.getElementById('input').addEventListener('keydown', function(e) {
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
document.getElementById('sendbtn').addEventListener('click', doSend);

// Load OpenRouter models dynamically
async function loadORModels() {
  try {
    var r = await fetch('/api/or-models');
    var d = await r.json();
    if (!d.ok) return;
    var orModels = d.models.map(function(m){ return 'openrouter/' + m; });
    var all = MODELS.concat(orModels);
    
    // Group by provider
    var local = all.filter(function(o){return o.startsWith('ollama/');});
    var anthropic = all.filter(function(o){return o.startsWith('anthropic/');});
    var openrouter = all.filter(function(o){return o.startsWith('openrouter/');});
    
    function renderOpts(arr) {
      return arr.map(function(o){
        var label = o.split('/').slice(-1)[0];
        return '<option value="'+o+'">'+label+'</option>';
      }).join('');
    }
    
    var html = '';
    if (local.length) html += '<optgroup label="🖥️ LOCAL (Free)">' + renderOpts(local) + '</optgroup>';
    if (anthropic.length) html += '<optgroup label="🔮 Anthropic">' + renderOpts(anthropic) + '</optgroup>';
    if (openrouter.length) html += '<optgroup label="🌐 OpenRouter">' + renderOpts(openrouter) + '</optgroup>';
    
    // Update bulk switcher dropdown
    var bulk = document.getElementById('bulk-model');
    if (bulk) {
      bulk.innerHTML = html;
    }
    // Update any open modal model selects
    MODELS.length = 0;
    all.forEach(function(m){ MODELS.push(m); });
  } catch(e) { console.log('OR models fetch failed:', e.message); }
}
loadORModels();

// Logging toggle
var loggingEnabled = true;

async function toggleLogging() {
  var r = await fetch('/api/logs/toggle', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  var d = await r.json();
  loggingEnabled = d.logging_enabled;
  updateLogButton();
}

function updateLogButton() {
  var btn = document.getElementById('log-toggle');
  if (btn) {
    btn.textContent = loggingEnabled ? '📝' : '🔇';
    btn.title = loggingEnabled ? 'Logging ON - click to disable' : 'Logging OFF - click to enable';
    btn.style.opacity = loggingEnabled ? '1' : '0.5';
  }
}

async function checkLoggingStatus() {
  try {
    var r = await fetch('/api/logs/status');
    var d = await r.json();
    loggingEnabled = d.logging_enabled;
    updateLogButton();
  } catch(e) {}
}
checkLoggingStatus();

async function setAllModels() {
  var model = document.getElementById('bulk-model').value;
  if (!confirm('Switch ALL personas to ' + model + '?')) return;
  var r = await fetch('/api/personas/set-model', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model})});
  var d = await r.json();
  if (d.ok) {
    PERSONAS.forEach(function(p){ p.llm = model; });
    document.querySelectorAll('.pmodel').forEach(function(el){ el.textContent = model; });
    document.getElementById('bulk-model').value = model;
    alert('Done — ' + d.updated + ' personas now using ' + model.split('/')[1]);
  } else alert('Error: ' + d.error);
}

function toggleSeeds() {
  var s = document.getElementById('seeds');
  var btn = document.getElementById('seeds-toggle');
  s.classList.toggle('expanded');
  btn.textContent = s.classList.contains('expanded') ? '▲ Suggestions' : '💡 Suggestions';
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

function toggleHistory() {
  var panel = document.getElementById('history-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) loadHistory();
}

function loadHistory() {
  var stored = localStorage.getItem('channeler_chats') || '{}';
  var chats = JSON.parse(stored);
  var list = document.getElementById('history-list');
  var keys = Object.keys(chats).sort(function(a,b){
    var ta = chats[a].updatedAt || '';
    var tb = chats[b].updatedAt || '';
    return tb.localeCompare(ta);
  });
  
  if (keys.length === 0) {
    list.innerHTML = '<div style="color:#556677;padding:20px;text-align:center">No chat history yet</div>';
    return;
  }
  
  list.innerHTML = keys.map(function(key) {
    var chat = chats[key];
    var p = PERSONAS.find(function(x){return x.id===key;});
    var name = p ? p.name : key;
    var av = p ? p.avatar : '💬';
    var msgs = chat.messages || [];
    var lastMsg = msgs.length > 0 ? msgs[msgs.length-1].content : '';
    var preview = lastMsg.slice(0, 60) + (lastMsg.length > 60 ? '...' : '');
    var date = chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString() : '';
    var isActive = current && current.id === key ? 'active' : '';
    return '<div class="history-item '+isActive+'" data-pid="'+key+'" onclick="loadChatFromHistory(this.dataset.pid)">'+
      '<div class="history-name"><span class="av">'+av+'</span>'+name+'</div>'+
      '<div class="history-meta">'+msgs.length+' messages · '+date+'</div>'+
      '<div class="history-preview">'+preview.replace(/</g,'&lt;')+'</div>'+
      '<div class="history-actions">'+
        '<button data-delkey="'+key+'" onclick="event.stopPropagation();deleteChatHistory(this.dataset.delkey)">🗑️ Delete</button>'+
      '</div>'+
    '</div>';
  }).join('');
}

function loadChatFromHistory(pid) {
  toggleHistory();
  // Close sidebar on mobile
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  // Switch to solo mode and pick persona
  if (mode !== 'solo') setMode('solo');
  pick(pid);
}

function deleteChatHistory(pid) {
  if (!confirm('Delete chat with '+pid+'?')) return;
  var stored = localStorage.getItem('channeler_chats') || '{}';
  var chats = JSON.parse(stored);
  delete chats[pid];
  localStorage.setItem('channeler_chats', JSON.stringify(chats));
  loadHistory();
  if (current && current.id === pid) {
    chatHistory = [];
    fullTranscript = [];
    document.getElementById('msgs').innerHTML = '';
  }
}

function newChat() {
  if (current) {
    chatHistory = [];
    fullTranscript = [];
    document.getElementById('msgs').innerHTML = '';
    saveChat();
  }
  toggleHistory();
}

// Close sidebar when picking persona on mobile - patched into pick()
var _origPick = pick;
pick = function(id) {
  _origPick(id);
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
  }
};


var currentSessionId = null;

function toggleSessions() {
  var panel = document.getElementById('sessions-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) loadSessions();
}

async function loadSessions() {
  var r = await fetch('/api/sessions');
  var d = await r.json();
  var list = document.getElementById('sessions-list');
  if (!d.sessions || d.sessions.length === 0) {
    list.innerHTML = '<div style="color:#556677;padding:20px;text-align:center">No saved sessions yet</div>';
    return;
  }
  list.innerHTML = d.sessions.map(function(s) {
    var avatars = (s.participants||[]).map(function(pid) {
      var p = PERSONAS.find(function(x){return x.id===pid;});
      return p ? p.avatar : '?';
    }).join('');
    var date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '';
    return '<div class="session-card" data-sid="'+s.id+'" onclick="loadSession(this.dataset.sid)">'+ 
      '<div class="session-name">'+(s.name||s.id)+'</div>'+
      '<div class="session-meta">'+s.messageCount+' messages · '+date+'</div>'+
      '<div class="session-avatars">'+avatars+'</div>'+
      '</div>';
  }).join('');
}

async function loadSession(id) {
  var r = await fetch('/api/sessions/'+id);
  var d = await r.json();
  if (!d.ok) { alert('Error loading session'); return; }
  var s = d.session;
  currentSessionId = id;
  groupIds = s.participants || [];
  fullTranscript = s.transcript || [];
  chatHistory = fullTranscript.filter(function(m){return m.role==='user'||m.role==='assistant';}).map(function(m){return {role:m.role==='user'?'user':'assistant', content:m.content};});
  
  // Switch to group mode and show chat
  setMode('group');
  groupIds.forEach(function(gid) {
    var cb = document.querySelector('#pc-'+gid+' .pcheck');
    if (cb) { cb.checked = true; }
    var card = document.getElementById('pc-'+gid);
    if (card) card.classList.add('ingroup');
  });
  updateGroupCount();
  
  // Render chat
  var participants = groupIds.map(function(gid){return PERSONAS.find(function(p){return p.id===gid;});}).filter(Boolean);
  document.getElementById('empty').style.display = 'none';
  document.getElementById('chatwrap').style.cssText = 'display:flex;flex:1;flex-direction:column;overflow:hidden;';
  var avatars = participants.map(function(p){return '<span title="'+p.name+'">'+p.avatar+'</span>';}).join('');
  var names = participants.map(function(p){return p.name;}).join(', ');
  document.getElementById('cheader').innerHTML = '<div class="cheader-participants">'+avatars+'</div><div><div class="cheader-name">'+(s.name||'Group')+'</div><div class="cheader-tag">'+participants.length+' participants</div></div><div class="cheader-btns"><button class="cbtn" onclick="openMemory()">💾 Memory</button><button class="cbtn" onclick="openExport()">Export</button><button class="cbtn" onclick="clearChat()">Clear</button></div>';
  document.getElementById('msgs').innerHTML = '';
  fullTranscript.forEach(function(m) {
    addMsgNoImage(m.role, m.content, m.name, m.avatar, m.persona_id);
  });
  document.getElementById('seeds').innerHTML = '';
  toggleSessions();
  document.getElementById('session-name').value = s.name || '';
}

async function saveCurrentSession() {
  if (mode !== 'group' || groupIds.length < 2) { alert('Start a group chat first'); return; }
  var name = document.getElementById('session-name').value.trim() || ('Group ' + new Date().toLocaleString());
  var data = {
    id: currentSessionId || ('session-' + Date.now()),
    name: name,
    participants: groupIds,
    transcript: fullTranscript
  };
  var r = await fetch('/api/sessions/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
  var d = await r.json();
  if (d.ok) {
    currentSessionId = d.id;
    alert('Session saved!');
    loadSessions();
  } else alert('Error: '+d.error);
}


document.querySelectorAll('.pcard').forEach(function(c){c.onclick=function(){pick(c.dataset.id);};});
</script>
<div class="lightbox" id="lightbox" onclick="closeLightbox()"><span class="lightbox-close">&times;</span><img id="lightbox-img"></div>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'self' http://localhost:* http://100.94.143.111:*; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://localhost:* http://100.94.143.111:*; connect-src 'self' http://localhost:* http://100.94.143.111:*"
    });
    return res.end(renderPage());
  }

  if (req.method === 'GET' && pathname === '/api/personas') {
    const personas = getPersonas().map(p => ({ id: p.id, name: p.name, avatar: p.avatar, tagline: p.tagline, type: p.type, llm: p.llm, seed_questions: p.seed_questions, system_prompt: p.system_prompt }));
    return respond(res, { ok: true, personas });
  }

  if (req.method === 'POST' && pathname === '/api/persona/create') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const file = path.join(PERSONAS_DIR, data.id + '.json');
        if (fs.existsSync(file)) return respond(res, { ok: false, error: 'ID already exists' }, 400);
        data.created_at = new Date().toISOString().slice(0,10);
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        respond(res, { ok: true, id: data.id });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/persona/update') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const file = path.join(PERSONAS_DIR, data.id + '.json');
        if (!fs.existsSync(file)) return respond(res, { ok: false, error: 'Persona not found' }, 404);
        const existing = JSON.parse(fs.readFileSync(file));
        Object.assign(existing, data);
        fs.writeFileSync(file, JSON.stringify(existing, null, 2));
        respond(res, { ok: true, id: data.id });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/persona/delete') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const file = path.join(PERSONAS_DIR, id + '.json');
        if (!fs.existsSync(file)) return respond(res, { ok: false, error: 'Persona not found' }, 404);
        fs.unlinkSync(file);
        respond(res, { ok: true, id });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/transcript/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const filename = data.filename.replace(/[^a-z0-9-]/gi, '-') + '.json';
        const filepath = path.join(TRANSCRIPTS_DIR, filename);
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        respond(res, { ok: true, path: 'transcripts/' + filename });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  
  // Serve images
  if (req.method === 'GET' && pathname.startsWith('/images/')) {
    const filename = pathname.replace('/images/', '');
    const filepath = path.join(IMAGES_DIR, filename);
    if (fs.existsSync(filepath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(filepath));
    }
    return respond(res, { ok: false, error: 'Image not found' }, 404);
  }

  // Generate image endpoint
  if (req.method === 'POST' && pathname === '/api/image/generate') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { prompt, negative, persona_id, persona_name, persona_avatar, model } = JSON.parse(body);
        const genRes = await generateImage(prompt, negative);
        if (!genRes.ok) return respond(res, genRes);
        
        const pollRes = await pollImage(genRes.prompt_id);
        if (!pollRes.ok) return respond(res, pollRes);
        
        // Copy from ComfyUI output to our images folder
        const srcPath = path.join(process.env.HOME, 'ComfyUI/output', pollRes.subfolder, pollRes.filename);
        const newName = 'img_' + Date.now() + '_' + pollRes.filename;
        const destPath = path.join(IMAGES_DIR, newName);
        fs.copyFileSync(srcPath, destPath);
        
        // Save metadata sidecar
        const meta = {
          filename: newName,
          prompt,
          persona_id: persona_id || 'unknown',
          persona_name: persona_name || 'Unknown',
          persona_avatar: persona_avatar || '🤖',
          model: model || 'unknown',
          timestamp: new Date().toISOString(),
          archived: false
        };
        fs.writeFileSync(destPath + '.meta.json', JSON.stringify(meta, null, 2));
        
        respond(res, { ok: true, filename: newName, url: '/images/' + newName });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // Gallery API - list all images with metadata
  if (req.method === 'GET' && pathname === '/api/gallery') {
    try {
      const files = fs.readdirSync(IMAGES_DIR)
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp'))
        .sort().reverse();
      
      const images = files.map(f => {
        const metaPath = path.join(IMAGES_DIR, f + '.meta.json');
        let meta = { filename: f, prompt: null, persona_name: 'Unknown', persona_avatar: '🤖', persona_id: 'unknown', model: 'unknown', timestamp: null, archived: false };
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
        } else {
          // Infer timestamp from filename (img_1773098535567_...)
          const tsMatch = f.match(/img_(\d+)_/);
          if (tsMatch) meta.timestamp = new Date(parseInt(tsMatch[1])).toISOString();
        }
        return { ...meta, url: '/images/' + f };
      });
      
      respond(res, { ok: true, images, count: images.length });
    } catch (e) {
      respond(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  // Serve the gallery page
  if (req.method === 'GET' && pathname === '/gallery') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Image Gallery — IdentityChannelerBot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a14;color:#e0e0f0;font-family:system-ui,sans-serif;min-height:100vh}
header{background:#111128;padding:14px 24px;border-bottom:1px solid #7c6fff33;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.logo{font-size:18px;font-weight:800;color:#7c6fff}.logo span{color:#00cfff}
.back{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;text-decoration:none}
.filters{display:flex;gap:10px;padding:16px 24px;border-bottom:1px solid #ffffff08;flex-wrap:wrap;align-items:center}
.filter-label{font-size:11px;color:#556677}
.filter-btn{background:#1a1a2e;border:1px solid #ffffff22;color:#8899bb;padding:5px 12px;border-radius:16px;font-size:11px;cursor:pointer}
.filter-btn.active{background:#7c6fff22;border-color:#7c6fff;color:#7c6fff}
.search{background:#111128;border:1px solid #ffffff22;color:#e0e0f0;padding:6px 12px;border-radius:6px;font-size:12px;min-width:200px}
.count{font-size:11px;color:#556677;margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;padding:20px 24px}
.card{background:#111128;border:1px solid #ffffff11;border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color 0.15s}
.card:hover{border-color:#7c6fff66}
.card img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.card-info{padding:12px}
.persona-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.persona-av{font-size:20px}
.persona-name{font-size:13px;font-weight:700;color:#fff}
.card-prompt{font-size:11px;color:#8899bb;line-height:1.5;max-height:48px;overflow:hidden}
.card-meta{display:flex;gap:8px;margin-top:8px;font-size:10px;color:#445566;flex-wrap:wrap}
.card-model{background:#00cfff11;color:#00cfff;padding:2px 6px;border-radius:4px}
.card-date{color:#445566}
.empty{padding:80px 24px;text-align:center;color:#445566}
.lightbox{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:100;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 20px}
.lightbox.open{display:flex}
.lightbox-inner{background:#111128;border:1px solid #ffffff22;border-radius:12px;max-width:900px;width:100%;overflow:hidden}
.lightbox-img{width:100%;max-height:70vh;object-fit:contain;background:#0a0a14}
.lightbox-info{padding:20px}
.lightbox-persona{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.lightbox-av{font-size:32px}
.lightbox-name{font-size:18px;font-weight:700}
.lightbox-tag{font-size:12px;color:#8899bb;margin-top:2px}
.lightbox-prompt{font-size:13px;color:#e0e0f0;line-height:1.6;margin-bottom:12px;background:#0a0a14;padding:12px;border-radius:8px}
.lightbox-meta{font-size:11px;color:#556677;display:flex;gap:12px;flex-wrap:wrap}
.lightbox-close{position:absolute;top:20px;right:20px;font-size:28px;color:#fff;cursor:pointer;background:#111128;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:1px solid #ffffff22}
.lightbox-close:hover{border-color:#ff446644;color:#ff4466}
@media(max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:12px}.card-info{padding:8px}.filters{padding:10px 12px}}
</style>
</head>
<body>
<header>
  <div class="logo">Identity<span>Channeler</span> · Gallery</div>
  <a class="back" href="/">← Back to Chat</a>
</header>
<div class="filters">
  <span class="filter-label">Filter:</span>
  <button class="filter-btn active" onclick="filterPersona('')">All</button>
  <div id="persona-filters"></div>
  <input class="search" id="search" placeholder="Search prompts..." oninput="applyFilters()">
  <span class="count" id="count"></span>
</div>
<div class="grid" id="grid"></div>
<div class="empty" id="empty" style="display:none">No images found.</div>
<div class="lightbox" id="lightbox" onclick="closeLightbox(event)">
  <div class="lightbox-inner" id="lightbox-inner">
    <img class="lightbox-img" id="lightbox-img">
    <div class="lightbox-info">
      <div class="lightbox-persona">
        <div class="lightbox-av" id="lb-av"></div>
        <div><div class="lightbox-name" id="lb-name"></div><div class="lightbox-tag" id="lb-model"></div></div>
      </div>
      <div class="lightbox-prompt" id="lb-prompt"></div>
      <div class="lightbox-meta" id="lb-meta"></div>
      <div class="lightbox-actions" id="lb-actions" style="display:flex;gap:10px;margin-top:16px">
        <button onclick="archiveCurrentImg()" style="background:#00cfff22;color:#00cfff;border:1px solid #00cfff44;padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer">📦 Archive</button>
        <button onclick="deleteCurrentImg()" style="background:#ff446622;color:#ff4466;border:1px solid #ff446644;padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer">🗑️ Delete</button>
      </div>
    </div>
  </div>
  <div class="lightbox-close" onclick="closeLightbox()">✕</div>
</div>
<script>
var allImages = [];
var activePersona = '';

async function load() {
  var r = await fetch('/api/gallery');
  var d = await r.json();
  allImages = d.images || [];
  buildPersonaFilters();
  applyFilters();
}

function buildPersonaFilters() {
  var seen = {};
  var btns = '';
  allImages.forEach(function(img) {
    var id = img.persona_id || 'unknown';
    if (!seen[id]) {
      seen[id] = true;
      btns += '<button class="filter-btn" onclick="filterPersona(\\''+id+'\\')" id="pfbtn-'+id+'">'+img.persona_avatar+' '+img.persona_name+'</button>';
    }
  });
  document.getElementById('persona-filters').innerHTML = btns;
}

function filterPersona(id) {
  activePersona = id;
  document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.remove('active');});
  var btn = id ? document.getElementById('pfbtn-'+id) : document.querySelector('.filter-btn');
  if (btn) btn.classList.add('active');
  applyFilters();
}

function applyFilters() {
  var q = (document.getElementById('search').value || '').toLowerCase();
  var filtered = allImages.filter(function(img) {
    if (activePersona && img.persona_id !== activePersona) return false;
    if (q && !(img.prompt || '').toLowerCase().includes(q) && !(img.persona_name || '').toLowerCase().includes(q)) return false;
    return true;
  });
  
  document.getElementById('count').textContent = filtered.length + ' / ' + allImages.length + ' images';
  
  if (filtered.length === 0) {
    document.getElementById('grid').innerHTML = '';
    document.getElementById('empty').style.display = 'block';
    return;
  }
  document.getElementById('empty').style.display = 'none';
  
  document.getElementById('grid').innerHTML = filtered.map(function(img, i) {
    var date = img.timestamp ? new Date(img.timestamp).toLocaleDateString() : '?';
    var model = (img.model || '').split('/').pop();
    var prompt = img.prompt ? img.prompt.slice(0, 120) + (img.prompt.length > 120 ? '...' : '') : 'No prompt saved';
    var idx = allImages.indexOf(img);
    return '<div class="card" onclick="openLightbox('+idx+')">' +
      '<img src="'+img.url+'" loading="lazy" onerror="this.src=\\'/images/placeholder.png\\'">' +
      '<div class="card-info">' +
        '<div class="persona-row"><div class="persona-av">'+(img.persona_avatar||'🤖')+'</div><div class="persona-name">'+(img.persona_name||'Unknown')+'</div></div>' +
        '<div class="card-prompt">'+prompt+'</div>' +
        '<div class="card-meta"><span class="card-model">'+model+'</span><span class="card-date">'+date+'</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

var currentImgIdx = -1;

function openLightbox(idx) {
  currentImgIdx = idx;
  var img = allImages[idx];
  document.getElementById('lightbox-img').src = img.url;
  document.getElementById('lb-av').textContent = img.persona_avatar || '🤖';
  document.getElementById('lb-name').textContent = img.persona_name || 'Unknown';
  document.getElementById('lb-model').textContent = (img.model || 'Unknown model');
  document.getElementById('lb-prompt').textContent = img.prompt || 'No prompt saved';
  var date = img.timestamp ? new Date(img.timestamp).toLocaleString() : '?';
  document.getElementById('lb-meta').innerHTML = '<span>📅 '+date+'</span><span>📁 '+img.filename+'</span>';
  document.getElementById('lightbox').classList.add('open');
}

async function archiveCurrentImg() {
  if (currentImgIdx < 0) return;
  var img = allImages[currentImgIdx];
  var r = await fetch('/api/image/archive', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:img.filename})});
  var d = await r.json();
  if (d.ok) {
    closeLightbox();
    allImages.splice(currentImgIdx, 1);
    applyFilters();
    alert('Archived!');
  } else alert('Error: '+d.error);
}

async function deleteCurrentImg() {
  if (currentImgIdx < 0) return;
  var img = allImages[currentImgIdx];
  if (!confirm('Delete '+img.filename+'? This cannot be undone.')) return;
  var r = await fetch('/api/image/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename:img.filename})});
  var d = await r.json();
  if (d.ok) {
    closeLightbox();
    allImages.splice(currentImgIdx, 1);
    applyFilters();
  } else alert('Error: '+d.error);
}

function closeLightbox(e) {
  if (!e || e.target === document.getElementById('lightbox') || e.target.classList.contains('lightbox-close')) {
    document.getElementById('lightbox').classList.remove('open');
  }
}

load();
</script>
</body>
</html>`;
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(html);
    return;
  }

  // Archive image
  if (req.method === 'POST' && pathname === '/api/image/archive') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename } = JSON.parse(body);
        const src = path.join(IMAGES_DIR, filename);
        const dest = path.join(ARCHIVE_DIR, filename);
        if (!fs.existsSync(src)) return respond(res, { ok: false, error: 'Not found' }, 404);
        fs.renameSync(src, dest);
        respond(res, { ok: true });
      } catch (e) {
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // List saved sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      const sessions = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f)));
        return { id: f.replace('.json',''), name: data.name, participants: data.participants, messageCount: data.transcript?.length || 0, updatedAt: data.updatedAt };
      }).sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''));
      respond(res, { ok: true, sessions });
    } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // Get a session
  if (req.method === 'GET' && pathname.startsWith('/api/sessions/')) {
    const id = pathname.replace('/api/sessions/', '');
    const file = path.join(SESSIONS_DIR, id + '.json');
    if (!fs.existsSync(file)) return respond(res, { ok: false, error: 'Not found' }, 404);
    const data = JSON.parse(fs.readFileSync(file));
    respond(res, { ok: true, session: data });
    return;
  }

  // Save a session
  if (req.method === 'POST' && pathname === '/api/sessions/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const id = data.id || ('session-' + Date.now());
        const file = path.join(SESSIONS_DIR, id + '.json');
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        respond(res, { ok: true, id });
      } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // Delete a session
  if (req.method === 'POST' && pathname === '/api/sessions/delete') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const file = path.join(SESSIONS_DIR, id + '.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        respond(res, { ok: true });
      } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // === MEMORIES API ===
  // Save a memory for a persona
  if (req.method === 'POST' && pathname === '/api/memories/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { persona_id, mode, conversation, summary } = JSON.parse(body);
        if (!persona_id) return respond(res, { ok: false, error: 'persona_id required' }, 400);
        
        const memFile = path.join(MEMORIES_DIR, persona_id + '.jsonl');
        const memory = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          timestamp: new Date().toISOString(),
          mode: mode || 'detailed', // 'compact' or 'detailed'
          summary: summary || null,
          conversation: mode === 'compact' ? null : conversation,
          message_count: conversation ? conversation.length : 0
        };
        
        fs.appendFileSync(memFile, JSON.stringify(memory) + '\n');
        respond(res, { ok: true, memory_id: memory.id, file: memFile });
      } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // List memories for a persona
  if (req.method === 'GET' && pathname.match(/^\/api\/memories\/([a-z0-9-]+)$/)) {
    const personaId = pathname.split('/').pop();
    try {
      const memFile = path.join(MEMORIES_DIR, personaId + '.jsonl');
      if (!fs.existsSync(memFile)) return respond(res, { ok: true, memories: [], count: 0 });
      const lines = fs.readFileSync(memFile, 'utf8').trim().split('\n').filter(Boolean);
      const memories = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      // Return without full conversation to keep response small
      const summaries = memories.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        mode: m.mode,
        summary: m.summary,
        message_count: m.message_count
      }));
      respond(res, { ok: true, memories: summaries, count: memories.length });
    } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // Search memories for a persona
  if (req.method === 'GET' && pathname.match(/^\/api\/memories\/([a-z0-9-]+)\/search$/)) {
    const personaId = pathname.split('/')[3];
    const query = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
    try {
      const memFile = path.join(MEMORIES_DIR, personaId + '.jsonl');
      if (!fs.existsSync(memFile)) return respond(res, { ok: true, results: [], count: 0 });
      const lines = fs.readFileSync(memFile, 'utf8').trim().split('\n').filter(Boolean);
      const memories = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      
      // Simple keyword search in summaries and conversations
      const q = query.toLowerCase();
      const results = memories.filter(m => {
        if (m.summary && m.summary.toLowerCase().includes(q)) return true;
        if (m.conversation) {
          return m.conversation.some(msg => msg.content && msg.content.toLowerCase().includes(q));
        }
        return false;
      }).map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        mode: m.mode,
        summary: m.summary,
        message_count: m.message_count,
        // Include matching conversation snippets
        matches: m.conversation ? m.conversation.filter(msg => 
          msg.content && msg.content.toLowerCase().includes(q)
        ).slice(0, 3) : []
      }));
      
      respond(res, { ok: true, query, results, count: results.length });
    } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // Get full memory by ID
  if (req.method === 'GET' && pathname.match(/^\/api\/memories\/([a-z0-9-]+)\/([a-z0-9]+)$/)) {
    const parts = pathname.split('/');
    const personaId = parts[3];
    const memoryId = parts[4];
    try {
      const memFile = path.join(MEMORIES_DIR, personaId + '.jsonl');
      if (!fs.existsSync(memFile)) return respond(res, { ok: false, error: 'No memories found' }, 404);
      const lines = fs.readFileSync(memFile, 'utf8').trim().split('\n').filter(Boolean);
      const memories = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const memory = memories.find(m => m.id === memoryId);
      if (!memory) return respond(res, { ok: false, error: 'Memory not found' }, 404);
      respond(res, { ok: true, memory });
    } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }


  if (req.method === 'POST' && pathname === '/api/personas/set-model') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { model } = JSON.parse(body);
        const files = fs.readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json'));
        files.forEach(f => {
          const fp = path.join(PERSONAS_DIR, f);
          const data = JSON.parse(fs.readFileSync(fp));
          data.llm = model;
          fs.writeFileSync(fp, JSON.stringify(data, null, 2));
        });
        respond(res, { ok: true, updated: files.length, model });
      } catch(e) { respond(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }


  if (req.method === 'GET' && pathname === '/api/or-models') {
    https.get({ hostname: 'openrouter.ai', path: '/api/v1/models', headers: { 'Authorization': 'Bearer ' + OPENROUTER_KEY } }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const models = JSON.parse(d).data.map(m => m.id).sort();
          respond(res, { ok: true, models });
        } catch(e) { respond(res, { ok: false, error: e.message }); }
      });
    }).on('error', e => respond(res, { ok: false, error: e.message }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const { persona_id, messages } = JSON.parse(body);
        const persona = getPersona(persona_id);
        if (!persona) return respond(res, { ok: false, error: 'Persona not found' }, 404);
        
        const response = await callLLM(persona, messages);
        const latencyMs = Date.now() - startTime;
        
        // Log the conversation (async, non-blocking) - if enabled
        if (loggingEnabled) {
          const logEntry = {
            timestamp: new Date().toISOString(),
            persona_id,
            persona_name: persona.name,
            model: persona.llm || 'unknown',
            latency_ms: latencyMs,
            user_message: messages[messages.length - 1]?.content || '',
            response: response.slice(0, 2000), // Cap at 2KB for log size
            message_count: messages.length,
            success: true
          };
          logConversation(logEntry);
          logToDaily(logEntry);
        }
        
        respond(res, { 
          ok: true, 
          response, 
          persona: persona.name,
          model: persona.llm || 'unknown',
          latency_ms: latencyMs,
          tokens_estimate: Math.round(response.length / 4) // rough estimate: ~4 chars per token
        });
      } catch (e) {
        const latencyMs = Date.now() - startTime;
        // Log errors too - if enabled
        if (loggingEnabled) {
          const logEntry = {
            timestamp: new Date().toISOString(),
            persona_id: 'error',
            error: e.message,
            latency_ms: latencyMs,
            success: false
          };
          logConversation(logEntry);
          logToDaily(logEntry);
        }
        
        respond(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // === LOGS API ===
  // Toggle logging on/off
  if (req.method === 'POST' && pathname === '/api/logs/toggle') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        if (typeof enabled === 'boolean') {
          loggingEnabled = enabled;
        } else {
          loggingEnabled = !loggingEnabled; // Toggle if no value provided
        }
        respond(res, { ok: true, logging_enabled: loggingEnabled });
      } catch (e) {
        loggingEnabled = !loggingEnabled; // Toggle on parse error too
        respond(res, { ok: true, logging_enabled: loggingEnabled });
      }
    });
    return;
  }

  // Get logging status
  if (req.method === 'GET' && pathname === '/api/logs/status') {
    respond(res, { ok: true, logging_enabled: loggingEnabled });
    return;
  }

  // GET /api/logs - list available log files
  // GET /api/logs/today - get today's combined log
  // GET /api/logs/:persona - get logs for specific persona (most recent month)
  // GET /api/logs/stats - get conversation statistics
  if (req.method === 'GET' && pathname === '/api/logs') {
    try {
      const months = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter(f => /^\d{4}-\d{2}$/.test(f)).sort().reverse() : [];
      const dailyLogs = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('-all.jsonl')).sort().reverse().slice(0, 7) : [];
      respond(res, { ok: true, months, recent_daily: dailyLogs, logs_dir: LOGS_DIR });
    } catch (e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/logs/today') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dailyFile = path.join(LOGS_DIR, `${today}-all.jsonl`);
      if (!fs.existsSync(dailyFile)) return respond(res, { ok: true, entries: [], count: 0 });
      const lines = fs.readFileSync(dailyFile, 'utf8').trim().split('\n').filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      respond(res, { ok: true, entries: entries.slice(-100), count: entries.length, file: dailyFile });
    } catch (e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/logs/stats') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dailyFile = path.join(LOGS_DIR, `${today}-all.jsonl`);
      let entries = [];
      if (fs.existsSync(dailyFile)) {
        const lines = fs.readFileSync(dailyFile, 'utf8').trim().split('\n').filter(Boolean);
        entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
      
      const byPersona = {};
      let totalLatency = 0, successCount = 0, errorCount = 0;
      for (const e of entries) {
        if (e.success) {
          successCount++;
          totalLatency += e.latency_ms || 0;
          byPersona[e.persona_id] = (byPersona[e.persona_id] || 0) + 1;
        } else {
          errorCount++;
        }
      }
      
      respond(res, {
        ok: true,
        date: today,
        total_conversations: entries.length,
        successful: successCount,
        errors: errorCount,
        avg_latency_ms: successCount ? Math.round(totalLatency / successCount) : 0,
        by_persona: byPersona
      });
    } catch (e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }

  const logsMatch = pathname.match(/^\/api\/logs\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && logsMatch) {
    try {
      const personaId = logsMatch[1];
      // Find most recent month with this persona's logs
      const months = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter(f => /^\d{4}-\d{2}$/.test(f)).sort().reverse() : [];
      let entries = [];
      for (const month of months) {
        const logFile = path.join(LOGS_DIR, month, `${personaId}.jsonl`);
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
          entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          break;
        }
      }
      respond(res, { ok: true, persona_id: personaId, entries: entries.slice(-50), count: entries.length });
    } catch (e) { respond(res, { ok: false, error: e.message }, 500); }
    return;
  }


  // Catch-all 404
  respond(res, { ok: false, error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  const count = fs.readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json')).length;
  console.log('IdentityChannelerBot running at http://localhost:' + PORT + ' - ' + count + ' personas');
});
