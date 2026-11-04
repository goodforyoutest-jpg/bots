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
  browse_click: ['Click a numbered control.', { index: 'n' }],
  browse_type: ['Type text into a numbered input.', { index: 'n', text: 's' }],
  browse_login: ['Log in with a saved login name (you never see the password).', { name: 's' }],
  web_search: ['Search the web (DuckDuckGo).', { query: 's' }],
  report_metric: ['Record a number for the live chart.', { name: 's', value: 'n' }],
  report_table: ['Add a result row.', { table: 's', row: 'o' }],
  notify: ['Send a notification to the user.', { text: 's' }],
};
const schema = (p) => ({ type: 'object', properties: Object.fromEntries(Object.entries(p).map(([k, t]) => [k, { type: t === 'n' ? 'number' : t === 'o' ? 'object' : 'string' }])), required: Object.keys(p).filter(k => k !== 'table') });

const READ = () => {
  const out = []; let n = 0;
  document.querySelectorAll('a[href],button,input,select,textarea,[role=button]').forEach(e => {
    const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return; n++; e.setAttribute('data-sb', n);
    const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    let k = e.tagName.toLowerCase(); if (k === 'input') k = 'input:' + (e.type || 'text');
    out.push('[' + n + '] ' + k + ((k === 'a' && e.href) ? ' -> ' + e.href.slice(0, 80) : '') + ': ' + t);
  });
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 5000), els: out.slice(0, 80) };
};
async function read(page) {
  const j = await page.evaluate(READ);
  return `Page: ${j.title}\nURL: ${j.url}\n\nText:\n${j.text}\n\nControls (use the number with browse_click or browse_type):\n${j.els.join('\n')}`;
}

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

async function runBot(req, emit) {
  const { goal, input, maxSteps = 20, maxMinutes = 10, tools: allowed = [], ai: cfg } = req;
  const allow = new Set([...allowed, 'report_metric', 'report_table']);
  const defs = [...allow].filter(n => TOOLS[n]).map(n => ({ name: n, d: TOOLS[n][0], s: schema(TOOLS[n][1]) }));
  const system = `You are a bot working for the user. Your job:\n${goal}\n\n${input ? 'Input:\n' + input + '\n\n' : ''}Work step by step. Pages come back as text with numbered controls. Use browse_login with a saved login name; you never see passwords. If a CAPTCHA or 2FA code is needed, stop and say so. Use report_metric and report_table as you go. Stay within ${maxSteps} steps. When finished, reply with a short summary and no tool call.`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const deadline = Date.now() + maxMinutes * 60000;
  const msgs = [{ role: 'user', content: 'Start the job now.' }];
  const anth = cfg.protocol === 'Anthropic';
  let last = '';
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() > deadline) return last || 'Stopped: time limit reached.';
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
    }
    return last || 'Stopped: step limit reached.';
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
    case 'browse_type': await page.fill(`[data-sb="${a.index}"]`, String(a.text), { timeout: 5000 }); return 'Typed into control ' + a.index + '.';
    case 'browse_click': {
      const sel = `[data-sb="${a.index}"]`;
      const label = await page.$eval(sel, e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 80)).catch(() => null);
      if (label === null) return 'Error: no control number ' + a.index + '. Use browse_read.';
      if (RISKY.test(label)) { if (!(await ask(emit, 'click “' + label + '” on a web page'))) return 'The user declined this click. Carry on without it or finish.'; }
      await page.click(sel, { timeout: 5000 }); await page.waitForTimeout(2200); return 'Clicked.\n' + await read(page);
    }
    case 'browse_login': {
      const l = LOGINS[a.name]; if (!l) return 'Error: no login “' + a.name + '” on the runner. Saved: ' + (Object.keys(LOGINS).join(', ') || 'none') + '. Set the LOGINS environment variable.';
      const host = new URL(page.url()).hostname.replace(/^www\./, '');
      if (host !== l.site && !host.endsWith('.' + l.site)) return 'Error: this page isn\'t ' + l.site + ', so I did not type the password.';
      const pw = page.locator('input[type=password]:visible').first();
      if (!(await pw.count())) return 'Error: no password field is visible. Open the login page first.';
      const us = page.locator('input[type=text]:visible, input[type=email]:visible, input:not([type]):visible').first();
      if (await us.count()) await us.fill(l.user);
      await pw.fill(l.pass); await pw.press('Enter'); await page.waitForTimeout(2500);
      return 'Login submitted. If a code (2FA) or CAPTCHA is needed, stop and tell the user.\n' + await read(page);
    }
  }
  return 'Error: unknown tool.';
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
    try { emit({ t: 'done', text: await runBot(b, emit) }); } catch (e) { emit({ t: 'error', text: e.message }); }
    clearInterval(beat); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(process.env.PORT || 8080, () => console.log('Stephen bot runner up'));
