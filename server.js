// Stephen bot runner: runs AI-driven browser bots online. Needs RUNNER_TOKEN. Optional: LOGINS='{"mysite":{"site":"example.com","user":"me","pass":"secret"}}'
const http = require('http');
const { chromium } = require('playwright');
const TOKEN = process.env.RUNNER_TOKEN || '';
const LOGINS = (() => { try { return JSON.parse(process.env.LOGINS || '{}'); } catch { return {}; } })();
const RISKY = /delete|remove|pay\b|payment|buy|purchase|place order|checkout|transfer|send money|unsubscribe|cancel (my )?subscription|confirm order/i;
const approvals = new Map();

const TOOLS = {
  browse_open: ['Open a web page (https) and read it.', { url: 's' }],
  browse_read: ['Read the current page again.', {}],
  browse_find: ['Search the current page for a few keywords and get ONLY matching text and controls. Cheaper than browse_read; prefer it.', { query: 's' }],
  browse_screenshot: ['Take a picture of the current page as evidence for the report (saved for the user).', { caption: 's' }],
  browse_click: ['Click a numbered control.', { index: 'n' }],
  browse_type: ['Type text into a numbered input.', { index: 'n', text: 's' }],
  browse_login: ['Log in with a saved login name (you never see the password).', { name: 's' }],
  web_search: ['Search the web (DuckDuckGo).', { query: 's' }],
  report_metric: ['Record a number for the live chart.', { name: 's', value: 'n' }],
  report_table: ['Add a result row.', { table: 's', row: 'o' }],
  notify: ['Send a notification to the user.', { text: 's' }],
};
const schema = (p) => ({ type: 'object', properties: Object.fromEntries(Object.entries(p).map(([k, t]) => [k, { type: t === 'n' ? 'number' : t === 'o' ? 'object' : 'string' }])), required: Object.keys(p).filter(k => k !== 'table') });

const LIB = `
function setv(e,v){if(e.tagName=='SELECT'){var o=[].slice.call(e.options).filter(function(o){return o.value==v||o.text.trim().toLowerCase()==String(v).toLowerCase();})[0];if(o)e.value=o.value;else if(/^\\d+$/.test(v)&&e.options[+v])e.selectedIndex=+v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return;}var p=e.tagName=='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
function __f(t,click){t=String(t).trim().replace(/^"|"$/g,'');if(/^[#.\\[]/.test(t)||/^[a-z][a-z0-9]*[#.\\[:>]/i.test(t)){try{var e0=document.querySelector(t);if(e0)return e0;}catch(x){}}var q=t.toLowerCase();var sel=click?'button,a,input[type=button],input[type=submit],[role=button],label,summary':'input,textarea,select';var best=null,score=0;document.querySelectorAll(sel).forEach(function(e){var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return;var cand=[e.innerText,e.value,e.placeholder,e.getAttribute('aria-label'),e.title,e.name,e.id];if(e.labels)for(var i=0;i<e.labels.length;i++)cand.push(e.labels[i].innerText);cand.forEach(function(c){if(!c)return;c=String(c).trim().toLowerCase();var s=c==q?3:(c.indexOf(q)==0?2:(c.indexOf(q)>=0?1:0));if(s>score){score=s;best=e;}});});if(!best&&!click){document.querySelectorAll('label').forEach(function(l){if(best)return;if((l.innerText||'').toLowerCase().indexOf(q)>=0){best=l.control||(l.parentElement&&l.parentElement.querySelector('input,select,textarea'));}});}if(best&&best.tagName=='LABEL'&&best.control)best=best.control;return best;}
function desc(e,n){var t=(e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||e.title||'').trim().replace(/\\s+/g,' ').slice(0,60);var k=e.tagName.toLowerCase();if(k=='input')k='input:'+(e.type||'text');return '['+n+'] '+k+((k=='a'&&e.href)?' -> '+e.href.slice(0,80):'')+': '+t;}
function numberAll(){var n=0,all=[];document.querySelectorAll('a[href],button,input,select,textarea,[role=button]').forEach(function(e){var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return;n++;e.setAttribute('data-sb',n);all.push([n,e]);});return all;}
function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}
function submitNear(f,anchor){var scope=f||document;var c=[].slice.call(scope.querySelectorAll('button,input[type=submit],input[type=button],[role=button],a')).filter(vis);var b=c.filter(function(x){return /log ?in|sign ?in|submit|continue|next|enter/i.test((x.innerText||x.value||'')+'');})[0]||c.filter(function(x){return x.type=='submit';})[0];if(b){b.click();return true;}if(f&&f.requestSubmit){f.requestSubmit();return true;}if(anchor){['keydown','keypress','keyup'].forEach(function(t){anchor.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});return true;}return false;}
`;
const J = JSON.stringify;
const ev = (page, body) => page.evaluate(`(function(){${LIB}${body}})()`);

async function read(page) {
  const j = JSON.parse(await ev(page, `var all=numberAll();return JSON.stringify({title:document.title,url:location.href,text:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,1800),els:all.slice(0,60).map(function(x){return desc(x[1],x[0]);})});`));
  return `Page: ${j.title}\nURL: ${j.url}\n\nText:\n${j.text}\n\nControls (use the number with browse_click or browse_type):\n${j.els.join('\n')}`;
}
async function find(page, query) {
  const j = JSON.parse(await ev(page, `var q=${J(query)};var all=numberAll();var terms=q.toLowerCase().split(/[^a-z0-9]+/).filter(function(x){return x.length>1;});var lines=(document.body?document.body.innerText:'').split(/\\n+/).map(function(s){return s.trim();}).filter(Boolean);var hits=[];lines.forEach(function(l,i){var low=l.toLowerCase();var c=0;terms.forEach(function(t){if(low.indexOf(t)>=0)c++;});if(c>0)hits.push([c,i,l.slice(0,220)]);});hits.sort(function(a,b){return b[0]-a[0]||a[1]-b[1];});var out=hits.slice(0,12).sort(function(a,b){return a[1]-b[1];}).map(function(h){return h[2];});var els=[];all.forEach(function(x){var d=desc(x[1],x[0]);var low=d.toLowerCase();var ok=false;terms.forEach(function(t){if(low.indexOf(t)>=0)ok=true;});if(ok&&els.length<15)els.push(d);});return JSON.stringify({title:document.title,url:location.href,lines:out,els:els,head:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,300)});`));
  if (!j.lines.length && !j.els.length) return `Nothing on this page matches “${query}”.\nPage: ${j.title} (${j.url})\nStart of page: ${j.head}`;
  return `Page: ${j.title} (${j.url})\nMatching text:\n${j.lines.map(l => '• ' + l).join('\n')}\n\nMatching controls (numbers work with browse_click / browse_type):\n${j.els.join('\n')}`;
}
const sub = (t) => String(t).replace(/\{\{login:([^.}]+)\.(user|pass)\}\}/g, (m, n, k) => { const l = LOGINS[n]; return l ? (k === 'user' ? l.user : l.pass) : m; });

async function ai(cfg, system, msgs, tools) {
  const anth = cfg.protocol === 'Anthropic';
  const url = cfg.baseUrl.replace(/\/$/, '') + (anth ? '/messages' : '/chat/completions');
  const headers = anth ? { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json' };
  const body = anth
    ? { model: cfg.model, max_tokens: 4096, system, messages: msgs, tools: tools.map(t => ({ name: t.name, description: t.d, input_schema: t.s })) }
    : { model: cfg.model, messages: [{ role: 'system', content: system }, ...msgs], tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.d, parameters: t.s } })), tool_choice: 'auto' };
  for (let a = 0; ; a++) {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if ((r.status === 429 || r.status >= 500) && a < 3) { await new Promise(s => setTimeout(s, 4000 << a)); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('AI error ' + r.status + ': ' + (j.error?.message || JSON.stringify(j).slice(0, 200)));
    if (anth) {
      const text = j.content.filter(c => c.type === 'text').map(c => c.text).join('');
      return { text, calls: j.content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, args: c.input })), usage: j.usage && [j.usage.input_tokens, j.usage.output_tokens], raw: j.content };
    }
    const m = j.choices[0].message;
    return { text: m.content || '', calls: (m.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || '{}') })), usage: j.usage && [j.usage.prompt_tokens, j.usage.completion_tokens], raw: m };
  }
}

function trimPages(msgs, anth) {
  const OLD = '[earlier page omitted to save tokens; use browse_find or browse_read if needed again]';
  const isPage = (t) => typeof t === 'string' && t.includes('\nControls (use');
  const slots = [];
  msgs.forEach((m, i) => {
    if (anth && Array.isArray(m.content)) m.content.forEach((c, j) => { if (c.type === 'tool_result' && isPage(c.content)) slots.push(() => { c.content = OLD; }); });
    else if (m.role === 'tool' && isPage(m.content)) slots.push(() => { m.content = OLD; });
  });
  slots.slice(0, -1).forEach(f => f());
}

async function runBot(req, emit) {
  const { goal, input, maxSteps = 20, maxMinutes = 10, tools: allowed = [], ai: cfg } = req;
  const allow = new Set([...allowed, 'report_metric', 'report_table']);
  const defs = [...allow].filter(n => TOOLS[n]).map(n => ({ name: n, d: TOOLS[n][0], s: schema(TOOLS[n][1]) }));
  const system = `You are a bot working for the user. Your job:\n${goal}\n\n${input ? 'Input:\n' + input + '\n\n' : ''}Be efficient: every page you read costs tokens. Never describe pages; collect only what the job needs. Use browse_find with a few keywords to pull out just the relevant text and controls; use browse_read only when you must see the whole page. To sign in: browse_open the login page, then browse_login with a saved login name (you never see passwords); other fields can use {{login:name.user}} / {{login:name.pass}} in browse_type. If browse_login says LOGIN MAY HAVE FAILED, or a CAPTCHA/2FA code is needed, stop and reply starting with "FAILED:" and the reason. Use report_metric and report_table as you go. Stay within ${maxSteps} steps. When finished reply with the final report and no tool call. ${req.report ? 'The final report MUST contain exactly this:\n' + req.report : 'The final report must be specific: real names, numbers and findings, not a description of what you did.'} If you could not complete the job, start the reply with "FAILED:" and say why.`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const deadline = Date.now() + maxMinutes * 60000;
  const msgs = [{ role: 'user', content: 'Start the job now.' }];
  const anth = cfg.protocol === 'Anthropic';
  let last = '';
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() > deadline) return 'FAILED: time limit reached. ' + last;
      trimPages(msgs, anth);
      const r = await ai(cfg, system, msgs, defs);
      if (r.usage) emit({ t: 'tokens', in: r.usage[0], out: r.usage[1] });
      if (!r.calls.length) return r.text || last || 'Done.';
      if (r.text) { last = r.text; emit({ t: 'step', text: r.text.slice(0, 200) }); }
      msgs.push(anth ? { role: 'assistant', content: r.raw } : r.raw);
      const results = [];
      for (const c of r.calls) {
        emit({ t: 'step', text: '▶ ' + c.name + ' ' + (c.name === 'browse_type' ? '#' + c.args.index + ' (text hidden)' : c.name === 'browse_login' ? '“' + c.args.name + '”' : JSON.stringify(c.args).slice(0, 120)) });
        let out;
        try { out = allow.has(c.name) ? await tool(c.name, c.args, page, emit) : 'Error: this bot isn\'t allowed to use ' + c.name; } catch (e) { out = 'Error: ' + e.message; }
        emit({ t: 'step', text: '  ↳ ' + String(out).replace(/\n/g, ' ').slice(0, 160) });
        results.push({ id: c.id, out: String(out).slice(0, 12000) });
      }
      if (anth) msgs.push({ role: 'user', content: results.map(x => ({ type: 'tool_result', tool_use_id: x.id, content: x.out })) });
      else results.forEach(x => msgs.push({ role: 'tool', tool_call_id: x.id, content: x.out }));
      await new Promise(r => setTimeout(r, 1200));
    }
    return 'FAILED: step limit reached. ' + last;
  } finally { await browser.close(); }
}

async function tool(name, a, page, emit) {
  switch (name) {
    case 'report_metric': emit({ t: 'metric', name: a.name, value: Number(a.value) }); return 'Recorded.';
    case 'report_table': emit({ t: 'table', table: a.table || 'Results', row: a.row || {} }); return 'Row added.';
    case 'notify': emit({ t: 'notify', text: String(a.text).slice(0, 300) }); return 'Sent.';
    case 'web_search': {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(a.query), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const h = await r.text();
      return [...h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>(.*?)<\/a>/g)].slice(0, 6)
        .map(m => m[2].replace(/<[^>]+>/g, '') + '\n' + decodeURIComponent((m[1].split('uddg=')[1] || m[1]).split('&')[0]) + '\n' + m[3].replace(/<[^>]+>/g, '')).join('\n\n') || 'No results.';
    }
    case 'browse_open': if (!/^https:\/\//.test(a.url)) return 'Error: only https:// pages.'; await page.goto(a.url, { timeout: 25000, waitUntil: 'load' }).catch(() => {}); await page.waitForTimeout(800); return read(page);
    case 'browse_read': return read(page);
    case 'browse_find': return find(page, a.query);
    case 'browse_screenshot': { const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!a.full }); emit({ t: 'shot', caption: a.caption || 'Screenshot', jpg: buf.toString('base64') }); return 'Screenshot saved for the report.'; }
    case 'browse_type': await page.fill(`[data-sb="${a.index}"]`, sub(a.text), { timeout: 5000 }); return 'Typed into control ' + a.index + '.';
    case 'browse_click': {
      const sel = `[data-sb="${a.index}"]`;
      const label = await page.$eval(sel, e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 80)).catch(() => null);
      if (label === null) return 'Error: no control number ' + a.index + '. Use browse_read.';
      if (RISKY.test(label)) { if (!(await ask(emit, 'click “' + label + '” on a web page'))) return 'The user declined this click. Carry on without it or finish.'; }
      await page.click(sel, { timeout: 5000 }); await page.waitForTimeout(2200); return 'Clicked.\n' + await read(page);
    }
    case 'browse_login': return login(page, a.name);
  }
  return 'Error: unknown tool.';
}

async function login(page, name) {
  const l = LOGINS[name]; if (!l) return 'Error: no login “' + name + '” on the runner. Saved: ' + (Object.keys(LOGINS).join(', ') || 'none') + '. Set the LOGINS environment variable.';
  const host = new URL(page.url()).hostname.replace(/^www\./, '');
  if (host !== l.site && !host.endsWith('.' + l.site)) return 'Error: this page isn\'t ' + l.site + ' (it is ' + host + '), so I did not type the password.';
  const body = `var ins=[].slice.call(document.querySelectorAll('input')).filter(vis);var pw=ins.filter(function(e){return e.type=='password';})[0];var us=ins.filter(function(e){return ['text','email','tel',''].indexOf(e.type)>=0&&(!pw||ins.indexOf(e)<ins.indexOf(pw));}).pop();if(!pw){if(!us)return 'no-fields';setv(us,${J(l.user)});return submitNear(us.form,us)?'username-step':'username-filled';}if(us)setv(us,${J(l.user)});setv(pw,${J(l.pass)});return submitNear(pw.form,pw)?'submitted':'filled-not-submitted';`;
  let r = await ev(page, body);
  if (r === 'no-fields') return 'Error: no login fields are visible. Open the site\'s login page first.';
  if (r === 'username-step' || r === 'username-filled') { await page.waitForTimeout(2200); r = await ev(page, body); if (r === 'no-fields') return 'Error: after the username step no password field appeared.'; }
  await page.waitForTimeout(3000);
  const still = await ev(page, `return [].slice.call(document.querySelectorAll('input[type=password]')).filter(vis).length?'yes':'no';`);
  const said = await ev(page, `return (document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,300);`);
  return still === 'yes' ? 'LOGIN MAY HAVE FAILED: the password field is still on the page (' + r + '). The page says: ' + said + '. If a code (2FA) or CAPTCHA is needed, stop and tell the user.' : 'Logged in (the login form is gone).\n' + await read(page);
}

// ---- recipes: fixed steps, no AI ----
const CMDS = ['open', 'type', 'select', 'click', 'wait', 'read', 'result', 'table', 'metric', 'login', 'notify', 'approve', 'log', 'screenshot'];
function parseRecipe(text) {
  const steps = []; const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line || line.startsWith('#')) continue;
    const n = i + 1, sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase(); let rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (!CMDS.includes(cmd)) throw new Error('Line ' + n + ': unknown step “' + cmd + '”.');
    let timeout = 0; const tm = rest.match(/\s+timeout=(\d+)\s*$/); if (tm) { timeout = +tm[1]; rest = rest.slice(0, tm.index).trim(); }
    const unq = (x) => x.replace(/^"|"$/g, '');
    if (cmd === 'type' || cmd === 'select' || cmd === 'metric') {
      const m = rest.match(/^("[^"]*"|\S+)\s*(.*)$/); if (!m || (cmd !== 'type' && !m[2])) throw new Error('Line ' + n + ': “' + cmd + '” needs two parts.');
      steps.push({ n, cmd, a: unq(m[1]), b: m[2], raw: line });
    } else if (cmd === 'wait') {
      if (/^\d+$/.test(rest)) steps.push({ n, cmd: 'sleep', a: rest, raw: line });
      else if (rest.startsWith('text ')) steps.push({ n, cmd: 'waittext', a: rest.slice(5).trim(), timeout, raw: line });
      else if (rest.startsWith('selector ')) steps.push({ n, cmd: 'waitsel', a: rest.slice(9).trim(), timeout, raw: line });
      else throw new Error('Line ' + n + ': use “wait 5”, “wait text …” or “wait selector …”.');
    } else if (cmd === 'screenshot') {
      const full = /^full(\s|$)/i.test(rest); steps.push({ n, cmd, a: (full ? rest.slice(4) : rest).trim().replace(/^"|"$/g, ''), full, raw: line });
    } else { if (!rest && cmd !== 'log') throw new Error('Line ' + n + ': “' + cmd + '” needs something after it.'); steps.push({ n, cmd, a: unq(rest), raw: line }); }
  }
  if (!steps.length) throw new Error('The steps are empty.');
  return steps;
}
const NUM = /-?\d[\d,]*\.?\d*/;
async function runRecipe(req, emit) {
  const steps = parseRecipe(req.recipe);
  const deadline = Date.now() + (req.maxMinutes || 10) * 60000;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const out = []; const tables = {};
  const fail = (s, m) => { throw new Error('FAILED: step ' + s.n + ' failed: ' + m); };
  emit({ t: 'step', text: 'Running ' + steps.length + ' fixed steps (no AI)' });
  try {
    for (const s of steps) {
      if (Date.now() > deadline) fail(s, 'the time limit ran out');
      emit({ t: 'step', text: '▶ ' + s.n + '. ' + (s.cmd === 'type' ? 'type ' + (s.a.includes(' ') ? '"' + s.a + '"' : s.a) + ' ••••' : s.raw.slice(0, 100)) });
      let r = '';
      switch (s.cmd) {
        case 'open': { if (!/^https:\/\//.test(sub(s.a))) fail(s, 'only https:// pages'); await page.goto(sub(s.a), { timeout: 25000, waitUntil: 'load' }).catch(() => fail(s, 'the page did not load')); await page.waitForTimeout(800); r = 'opened ' + (await page.title()); break; }
        case 'type': case 'select': { const ok = await ev(page, `var e=__f(${J(s.a)},false);if(!e)return 'nf';if(e.focus)e.focus();setv(e,${J(sub(s.b))});return 'ok';`); if (ok !== 'ok') fail(s, 'no field matches “' + s.a + '”'); r = 'ok'; break; }
        case 'click': {
          const label = await ev(page, `var e=__f(${J(s.a)},true);if(!e)return 'NF';return ((e.innerText||e.value||e.getAttribute('aria-label')||'')+'').trim().slice(0,80);`);
          if (label === 'NF') fail(s, 'no button or link matches “' + s.a + '”');
          if (RISKY.test(label) && !(await ask(emit, 'click “' + label + '” on a web page'))) fail(s, 'you declined the click on “' + label + '”');
          await ev(page, `var e=__f(${J(s.a)},true);if(e){e.scrollIntoView();e.click();}return 'ok';`); await page.waitForTimeout(1500); r = 'clicked “' + label + '”'; break;
        }
        case 'sleep': await page.waitForTimeout(Math.min(+s.a, 3600) * 1000); r = 'waited'; break;
        case 'waittext': case 'waitsel': {
          const limit = Math.min(Date.now() + (s.timeout || 60) * 1000, deadline); let ok = false;
          while (Date.now() < limit) {
            ok = s.cmd === 'waittext' ? await ev(page, `return (document.body&&document.body.innerText.indexOf(${J(s.a)})>=0)?'y':'n';`) === 'y' : await ev(page, `try{return document.querySelector(${J(s.a)})?'y':'n';}catch(e){return 'n';}`) === 'y';
            if (ok) break; await page.waitForTimeout(1000);
          }
          if (!ok) fail(s, '“' + s.a + '” did not appear in time'); r = 'found'; break;
        }
        case 'read': case 'result': {
          const t = await ev(page, `var e=__f(${J(s.a)},true)||__f(${J(s.a)},false);if(!e)return 'NF';return ((e.innerText||e.value||'')+'').trim().replace(/\\s+/g,' ').slice(0,2000);`);
          if (t === 'NF') fail(s, 'nothing matches “' + s.a + '”'); out.push(s.cmd === 'read' ? s.a + ': ' + t.slice(0, 600) : t.slice(0, 1500)); r = t; break;
        }
        case 'table': {
          const rows = JSON.parse((await ev(page, `try{var e=document.querySelector(${J(s.a)});if(!e)return '[]';if(e.tagName!='TABLE')e=e.querySelector('table');if(!e)return '[]';return JSON.stringify([].slice.call(e.rows).map(function(r){return [].slice.call(r.cells).map(function(c){return c.innerText.trim().replace(/\\s+/g,' ');});}));}catch(x){return '[]';}`)) || '[]').filter(x => x.length);
          if (!rows.length) fail(s, 'no table found at “' + s.a + '”');
          const two = rows.every(x => x.length === 2);
          for (const x of rows) {
            const row = two ? { Item: x[0], Value: x[1] } : Object.fromEntries(x.map((v, i) => ['Col' + (i + 1), v]));
            emit({ t: 'table', table: s.a, row }); (tables[s.a] = tables[s.a] || []).push(Object.values(row).join(': '));
            if (two) { const m = x[1].match(NUM); if (m) emit({ t: 'metric', name: x[0].slice(0, 30), value: parseFloat(m[0].replace(/,/g, '')) }); }
          }
          r = rows.length + ' rows'; break;
        }
        case 'metric': {
          const t = await ev(page, `var e=__f(${J(s.b)},true)||__f(${J(s.b)},false);if(!e)return 'NF';return ((e.innerText||e.value||'')+'').trim();`);
          if (t === 'NF') fail(s, 'nothing matches “' + s.b + '”'); const m = t.match(NUM); if (!m) fail(s, 'no number in “' + t.slice(0, 40) + '”');
          emit({ t: 'metric', name: s.a, value: parseFloat(m[0].replace(/,/g, '')) }); r = s.a + ' = ' + m[0]; break;
        }
        case 'login': { r = await login(page, s.a); if (r.startsWith('Error') || r.startsWith('LOGIN MAY HAVE FAILED')) fail(s, r.slice(0, 200)); r = 'logged in'; break; }
        case 'notify': emit({ t: 'notify', text: s.a.slice(0, 300) }); r = 'sent'; break;
        case 'approve': if (!(await ask(emit, s.a))) fail(s, 'you said no'); r = 'approved'; break;
        case 'log': r = 'noted'; break;
        case 'screenshot': { const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!s.full }); emit({ t: 'shot', caption: s.a || 'Screenshot', jpg: buf.toString('base64') }); r = 'saved'; break; }
      }
      emit({ t: 'step', text: '  ↳ ' + String(r).slice(0, 120) });
    }
    return ('Finished all ' + steps.length + ' steps.\n' + out.join('\n') + '\n' + Object.entries(tables).map(([k, v]) => k + ':\n' + v.slice(0, 25).join('\n')).join('\n')).trim();
  } finally { await browser.close(); }
}

function ask(emit, what) {
  const id = Math.random().toString(36).slice(2);
  return new Promise(res => { approvals.set(id, res); emit({ t: 'approval', id, what }); setTimeout(() => { if (approvals.delete(id)) res(false); }, 10 * 60000); });
}

const body = (req) => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  if (!TOKEN || req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('unauthorized'); }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/approve' && req.method === 'POST') { const b = await body(req); const f = approvals.get(b.id); if (f) { approvals.delete(b.id); f(!!b.ok); } res.writeHead(200); return res.end('ok'); }
  if (req.url === '/run' && req.method === 'POST') {
    const b = await body(req);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const emit = (o) => res.write(JSON.stringify(o) + '\n');
    const beat = setInterval(() => res.write('\n'), 15000);
    try { emit({ t: 'done', text: b.mode === 'recipe' ? await runRecipe(b, emit) : await runBot(b, emit) }); } catch (e) { emit({ t: 'error', text: e.message }); }
    clearInterval(beat); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(process.env.PORT || 8080, () => console.log('Stephen bot runner up'));
