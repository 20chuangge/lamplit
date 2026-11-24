/**
 * smoke-cost.mjs - 1.5.50: what the money really is, and spending less of it.
 *
 * The 11-20 cost calibration (real records from both machines) found:
 *   B1  a price saved by hand before 1.5.29 has no `peak`, so every call on
 *       that machine was counted at the peak price (+40-90% on the cloud);
 *   B2  evaluation runs counted as the human's daily spend;
 *   B3  days with no spend were left out of the daily average;
 *   B4  the day the cache data started (half a day) was taken as a whole day;
 *   B5  vision, rule checks, translation and connection tests never reached the ledger;
 * and the savings:
 *   S1  the 发布 bot rewrote CDP typing scripts for every 小红书 post (100-150
 *       steps): the browser can type paragraphs into an editor, append and
 *       press keys; a script written again and again is said once; 「继续」
 *       goes on from where the last turn stopped;
 *   S2  a routine may wait for the off-peak hours (half price);
 *   S3  a page read is stale once the page was read again;
 *   S4  evaluation bots are marked and may use their own model;
 *   S5  the share of output spent thinking is recorded.
 *
 * Run by scripts/smoke.mjs as its own stage (kept apart from smoke.mjs so it
 * merges cleanly next to other work).
 */
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export async function costChecks({ check, readText, api, home, toolsMod }) {
  const U = await import('../src/usage.mjs');
  const dataDir = process.env.ASSIST_DATA_DIR || path.join(home, 'data');
  const settingsPath = path.join(dataDir, 'usage-settings.json');
  const savedSettings = await fsp.readFile(settingsPath, 'utf8').catch(() => null);

  // --- B1: a hand-saved price that is the site's price takes the site's peak rule --------
  {
    await fsp.writeFile(settingsPath, JSON.stringify({ currency: 'CNY', prices: {
      'deepseek-flash': { in: 2, out: 8, cached: 0.04 },
      'deepseek-v4.1-flash': { in: 2, out: 8 },
      'my-own': { in: 3, out: 9, cached: 0.1 },
    } }));
    const s = U.readUsageSettings();
    const off = { ts: '2026-11-20T12:00:00Z', prompt: 1e6, cached: 9e5, completion: 1e5, total: 1.1e6 }; // Friday 20:00 Beijing
    const peakRec = { ...off, ts: '2026-11-20T02:00:00Z' }; // Friday 10:00 Beijing
    const p = U.priceOf(s, 'deepseek-flash');
    check('C50-B1 a price saved by hand before 1.5.29 that is DeepSeek\'s own (in 2 / out 8 / cached 0.04) gets the peak rule: off-peak calls cost half, not the full price',
      p.peak === true && Math.abs(U.recordCost(off, p) * 2 - U.recordCost(peakRec, p)) < 1e-12, JSON.stringify(p));
    check('C50-B1 the same with no cached price saved: the site\'s cached price and peak rule are taken; a price of the human\'s own is left as it is',
      s.prices['deepseek-v4.1-flash'].peak === true && s.prices['deepseek-v4.1-flash'].cached === 0.04 && !s.prices['my-own'].peak && s.prices['my-own'].in === 3,
      JSON.stringify(s.prices));
    const viaApi = (await api('/api/usage?days=1')).json || {};
    check('C50-B1 the cost page and the checkup read the corrected price (nothing to click)',
      viaApi.settings?.prices?.['deepseek-flash']?.peak === true, JSON.stringify(viaApi.settings?.prices || {}));
    U.fixHandPrices && await U.fixHandPrices();
    const onDisk = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    check('C50-B1 the corrected price is written back once at start (fixHandPrices), so the file says peak too',
      typeof U.fixHandPrices === 'function' && onDisk.prices?.['deepseek-flash']?.peak === true);
    const serverSrc = await readText('../src/server.mjs');
    check('C50-B1 the server corrects the file when it starts', serverSrc.includes('fixHandPrices()'));
  }

  // --- B2 / S4: evaluation runs are marked and kept out of the human's pace ----------------
  {
    const rp = { prices: { m: { in: 2, out: 8, cached: 0.04 } } };
    const now = new Date(2026, 10, 20, 12, 0, 0);
    const rec = (day, extra = {}) => ({ day, ts: `${day}T12:00:00Z`, model: 'm', prompt: 1e6, completion: 0, total: 1e6, cached: 0, ...extra });
    const records = [rec('2026-11-18'), rec('2026-11-19'), rec('2026-11-18', { botName: '评测-f1-sort' }), rec('2026-11-19', { botId: 'h1-venue-ask' }), rec('2026-11-19', { eval: true })];
    const r = U.spendRate(records, rp, now);
    check('C50-B2 evaluation runs (a bot named 评测-…, an old task id like h1-venue-ask, or marked eval) are not the human\'s daily spend',
      typeof U.isEvalRecord === 'function' && U.isEvalRecord(records[2]) && U.isEvalRecord(records[3]) && U.isEvalRecord(records[4]) && !U.isEvalRecord(records[0])
      && Math.abs(r.perDay - 2) < 0.01, JSON.stringify(r));
    const sum = U.summarizeUsage(records, rp);
    check('C50-B2 the summary says what evaluation cost, apart (it is real money, but not the pace)',
      sum.eval?.calls === 3 && Math.abs(sum.eval.cost - 6) < 0.01 && sum.totals.calls === 5, JSON.stringify(sum.eval));
    const made = await api('/api/bots', { method: 'POST', body: { name: '评测-c50', role: '评测用的临时机器人', eval: true } });
    const botId = made.json?.bot?.id || made.json?.id;
    const got = botId ? (await api(`/api/bots/${encodeURIComponent(botId)}`)).json : null;
    check('C50-S4 a bot can be made as an evaluation bot (eval: true is kept)', Boolean(got?.bot?.eval ?? got?.eval), JSON.stringify(made.json || {}).slice(0, 200));
    if (botId) await api(`/api/bots/${encodeURIComponent(botId)}?forget=1`, { method: 'DELETE' }).catch(() => {});
    const agentSrc = await readText('../src/agent.mjs');
    const evalSrc = await readText('./eval.mjs');
    check('C50-S4 its calls are recorded as evaluation; the runner marks its bots and can give them their own model (EVAL_MODEL / --model) so a separate key pays for them',
      (agentSrc.match(/\.\.\.\(bot\.eval \? \{ eval: true \} : \{\}\)/g) || []).length >= 2 && evalSrc.includes('eval: true') && evalSrc.includes('EVAL_MODEL'));
  }

  // --- B3 / B4: the daily average ------------------------------------------------------------
  {
    const rp = { prices: { m: { in: 2, out: 8, cached: 0.04 } } };
    const now = new Date(2026, 10, 20, 12, 0, 0);
    const rec = (day, extra = {}) => ({ day, ts: `${day}T12:00:00Z`, model: 'm', prompt: 1e6, completion: 0, total: 1e6, cached: 0, ...extra });
    const idle = U.spendRate([rec('2026-11-17')], rp, now);
    check('C50-B3 a day with nothing spent counts as a day: ¥2 on 11-17 and nothing on 11-18 and 11-19 is ¥0.67 a day, not ¥2',
      idle.basis === 'days' && Math.abs(idle.perDay - 0.67) < 0.01 && idle.days === 3, JSON.stringify(idle));
    const { cached: _drop, ...uncached } = rec('2026-11-17');
    const upgrade = U.spendRate([{ ...uncached, cached: undefined }, rec('2026-11-17', { cached: 1e6, prompt: 1e6 }), rec('2026-11-18'), rec('2026-11-19')], rp, now);
    check('C50-B4 the day the cache data started (half the day without it) is not taken as a whole day when later days are there',
      upgrade.days === 2 && Math.abs(upgrade.perDay - 2) < 0.01, JSON.stringify(upgrade));
    const onlyUpgrade = U.spendRate([{ ...uncached, cached: undefined }, rec('2026-11-19', { cached: 0 })], rp, now);
    check('C50-B4 …but when it is the only day, it is used', onlyUpgrade.basis === 'days' && onlyUpgrade.days >= 1, JSON.stringify(onlyUpgrade));
  }

  // --- B5: every model call reaches the ledger -----------------------------------------------
  {
    const tr = await api('/api/translate', { method: 'POST', body: { text: '你好', to: 'en' } });
    const after = (await api('/api/usage?days=1')).json || {};
    check('C50-B5 a translation is recorded (source translate) and the summary has a line per kind of call',
      tr.status === 200 && (after.bySource || []).some((s) => s.key === 'translate'), JSON.stringify((after.bySource || []).map((s) => s.key)));
    const R = await import('../src/rules.mjs');
    const seen = [];
    await R.judgeRules({ rules: [{ id: 'r1', text: '发邮件先问我' }], toolName: 'shell', args: { command: 'echo c50-unique' },
      model: { provider: 'fake', model: 'fake-m', complete: async () => ({ content: '{"rules": []}', usage: { prompt_tokens: 100, completion_tokens: 5 } }) },
      onUsage: (u) => seen.push(u) });
    check('C50-B5 a rule check reports its tokens (onUsage), and the agent records them as source rule',
      seen.length === 1 && seen[0].usage?.prompt_tokens === 100 && (await readText('../src/agent.mjs')).includes("source: 'rule'"), JSON.stringify(seen));
    const V = await import('../src/vision.mjs');
    const fake = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '一个按钮' } }], usage: { prompt_tokens: 800, completion_tokens: 20 } }) });
    const v = await V.describeImage({ baseUrl: 'http://x', model: 'vl', apiKey: 'k' }, Buffer.from('png'), 'image/png', '是什么', { fetchImpl: fake });
    const toolsSrc = await readText('../src/tools.mjs');
    check('C50-B5 looking at a picture returns the vision model\'s tokens, and image_view records them (source vision, the vision model\'s own name)',
      v.usage?.prompt_tokens === 800 && toolsSrc.includes("source: 'vision'"), JSON.stringify(v));
    const setSrc = await readText('../src/settings.mjs');
    check('C50-B5 connection tests (Settings and the deep checkup) are recorded too (source check)', setSrc.includes("source: 'check'"));
  }

  // --- S5: thinking tokens -------------------------------------------------------------------
  {
    const r = await U.recordUsage({ botId: 'c50', model: 'deepseek-flash', usage: { prompt_tokens: 1000, completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 300 } }, source: 'chat' });
    const sum = U.summarizeUsage([r, { ...r, reasoning: undefined, completion: 100 }], { prices: {} });
    const apps = await readText('../public/app/main/09-apps.js');
    check('C50-S5 the tokens spent thinking are recorded with each call and added up; the cost page says what share of the output was thinking',
      r.reasoning === 300 && sum.totals.reasoning === 300 && apps.includes('其中思考'), JSON.stringify({ r, t: sum.totals }));
  }

  // --- S2: a routine may wait for the off-peak hours -----------------------------------------
  {
    const RT = await import('../src/routines.mjs');
    const bj = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 8, m); // Beijing time
    const ok = typeof RT.offPeakAfter === 'function'
      && RT.offPeakAfter(bj(20, 10, 30)) === bj(20, 12, 0) // Friday 10:30 -> 12:00
      && RT.offPeakAfter(bj(20, 15, 0)) === bj(20, 18, 0) // Friday 15:00 -> 18:00
      && RT.offPeakAfter(bj(20, 19, 0)) === bj(20, 19, 0) // evening: as it is
      && RT.offPeakAfter(bj(21, 10, 30)) === bj(21, 10, 30); // Saturday: as it is
    check('C50-S2 off-peak: a run due in DeepSeek\'s peak hours (weekdays 9-12, 14-18 Beijing) moves to the next off-peak start (12:00 or 18:00); other times stay', ok);
    const parsed = RT.parseSchedule('30 10 * * *');
    const plain = RT.nextRunAt({ ...parsed, offPeak: false }, bj(20, 8, 0), 'Asia/Shanghai');
    const waits = RT.nextRunAt({ ...parsed, offPeak: true }, bj(20, 8, 0), 'Asia/Shanghai');
    check('C50-S2 a routine with offPeak set is planned at 12:00 instead of 10:30; without it, at 10:30 (off by default)',
      plain === bj(20, 10, 30) && waits === bj(20, 12, 0), `${new Date(plain).toISOString()} ${new Date(waits).toISOString()}`);
    const made = await api('/api/routines', { method: 'POST', body: { name: 'c50 闲时', instruction: '看一眼', schedule: '每天 10:30', offPeak: true } });
    const id = made.json?.routine?.id;
    const off = id ? await api(`/api/routines/${encodeURIComponent(id)}`, { method: 'PATCH', body: { offPeak: false } }) : null;
    check('C50-S2 the option is saved, shown and can be switched off (API)', made.json?.routine?.offPeak === true && off?.json?.routine?.offPeak === false, JSON.stringify(made.json).slice(0, 200));
    if (id) await api(`/api/routines/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    const page = await readText('../public/index.html');
    const toolsSrc = await readText('../src/tools.mjs');
    check('C50-S2 the routine form has 「闲时再跑」 with the saving said in words; a card can switch it; bots can set it (routine_create / routine_update)',
      page.includes('id="rt-off-peak"') && page.includes('模型费省一半') && page.includes("$('rt-off-peak').checked") && page.includes('闲时再跑')
      && (toolsSrc.match(/offPeak: \{ type: 'boolean'/g) || []).length >= 2);
  }

  // --- S3: a page read is stale once the page was read again --------------------------------
  {
    const A = await import('../src/agent.mjs');
    const msgs = [{ role: 'system', content: 's' }];
    const add = (i, name, args = {}) => msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `s${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, { role: 'tool', tool_call_id: `s${i}`, content: `${name} ` + 'z'.repeat(3000) });
    add(0, 'browser_snapshot'); add(1, 'browser_click', { ref: '@e1' }); add(2, 'browser_snapshot'); add(3, 'browser_snapshot');
    A.trimOldToolOutputs(msgs, { batch: 1 });
    const t = msgs.filter((m) => m.role === 'tool');
    // 1.5.68: a click returns the page after it, so it is a page read too - stale once the page was read again.
    check('C50-S3 only the latest page read (snapshot, screenshot, picture, the page a click returns) stays whole; phone looks still keep two',
      /earlier output trimmed/.test(t[0].content) && /earlier output trimmed/.test(t[1].content) && /earlier output trimmed/.test(t[2].content) && t[3].content.length > 3000);
    const toolsSrc = await readText('../src/tools.mjs');
    check('C50-S3 the screenshot tool says to read the page with browser_snapshot first, not screenshot + image_view + snapshot of the same state',
      toolsSrc.includes('Do not look at the same page state twice'));
  }

  // --- S1: the browser types like a person; a rewritten script is said once; 「继续」 goes on ---
  {
    const A = await import('../src/agent.mjs');
    const receipts = [1, 2, 3].map((i) => [{ name: 'fs_write', args: { path: `work/type_body${i}.py` }, ok: true }, { name: 'shell', args: { command: `python3 work/type_body${i}.py text a.txt` }, ok: true }]).flat();
    const note = typeof A.scriptRewriteNote === 'function' ? A.scriptRewriteNote(receipts) : '';
    check('C50-S1 a turn that writes a third throw-away script to drive a page is told once: use browser_type / browser_press, or keep one script with parameters and save it as a skill',
      /browser_press/.test(note) && /skill_save/.test(note) && A.scriptRewriteNote(receipts.slice(0, 4)) === '', note);
    check('C50-S1 「继续」「我弄好了，继续」「接着做」 are a go-on; a new request is not',
      typeof A.isGoOn === 'function' && A.isGoOn('继续') && A.isGoOn('我弄好了，继续') && A.isGoOn('接着做吧') && A.isGoOn('好了') && !A.isGoOn('帮我发一篇新的笔记，题目是继续努力'));
    const rn = typeof A.resumeNote === 'function' ? A.resumeNote({ text: '发 D12', status: 'success', waitingFor: 'takeover', actions: ['browser_open(url="https://creator.example/publish")', 'browser_upload(path="a.png")'] }) : '';
    check('C50-S1 the go-on carries what the last turn already did and says to go on from there, not check everything again',
      /browser_upload/.test(rn) && /不要从头/.test(rn) && /发 D12/.test(rn), rn);
    const agentSrc = await readText('../src/agent.mjs');
    check('C50-S1 wiring: an unfinished turn (stopped, failed, waiting for a takeover or login) is kept per bot for a few hours; a go-on picks it up once',
      agentSrc.includes('this.unfinished') && agentSrc.includes('resumeNote(') && agentSrc.includes('isGoOn(text)'));

    // The browser itself: paragraphs into a rich editor, append, keys.
    const PAGE = '<!doctype html><html><body><div id="ed" contenteditable="true" style="min-height:80px;border:1px solid #ccc"></div><div id="sug" style="display:none">#秋招</div>'
      + '<script>const ed=document.getElementById("ed");document.addEventListener("keydown",e=>{if(e.key==="Enter"&&ed.innerText.trim().endsWith("#秋")){e.preventDefault();window.__picked=true;}});</script></body></html>';
    const srv = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(PAGE); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = { chromePath: process.env.CHROME_PATH, headless: process.env.BROWSER_HEADLESS, allowPrivate: process.env.ALLOW_PRIVATE };
    process.env.BROWSER_HEADLESS = '1';
    process.env.ALLOW_PRIVATE = '1';
    delete process.env.CHROME_PATH;
    const workspaceDir = path.join(home, 'workspace');
    const registry = toolsMod.createRegistry({ workspaceDir, config: { policy: {} }, getRuntime: () => { throw new Error('no runtime'); }, getRoutines: () => { throw new Error('no routines'); } });
    const ctx = { workspaceDir, bot: { id: 'c50-browser' }, turnId: 'c50' };
    const call = (name, args = {}) => registry.get(name)?.run(args, ctx);
    try {
      const press = registry.get('browser_press');
      check('C50-S1 browser_press is a tool (Enter, Escape, Tab, arrows, Backspace, Ctrl+End …), MEDIUM like typing', press && press.risk === 'MEDIUM');
      const opened = await call('browser_open', { url: `http://127.0.0.1:${srv.address().port}/` });
      if (!opened?.ok) {
        check('C50-S1 (browser) no browser on this machine: typing checks skipped', /NOT_FOUND|not_configured|BROWSER/i.test(JSON.stringify(opened)), JSON.stringify(opened).slice(0, 200));
      } else {
        const t1 = await call('browser_type', { selector: '#ed', text: '第一段\n第二段' });
        const after1 = await call('browser_eval', { expression: 'document.getElementById("ed").innerText' });
        check('C50-S1 browser_type puts several paragraphs into a rich editor (a new line is Enter, not a lost \\n)',
          t1?.ok === true && /第一段\s*\n+\s*第二段/.test(String(after1?.value || '')), JSON.stringify({ t1, after1 }).slice(0, 300));
        const t2 = await call('browser_type', { selector: '#ed', text: '#秋', append: true });
        const after2 = await call('browser_eval', { expression: 'document.getElementById("ed").innerText' });
        check('C50-S1 browser_type with append: true adds at the end and keeps what is there',
          t2?.ok === true && /第一段/.test(String(after2?.value || '')) && /#秋\s*$/.test(String(after2?.value || '')), JSON.stringify(after2).slice(0, 300));
        const p = await call('browser_press', { keys: 'Enter' });
        const picked = await call('browser_eval', { expression: 'window.__picked === true' });
        check('C50-S1 browser_press sends a real key to the page (a topic picked from its list with Enter)', p?.ok === true && picked?.value === true, JSON.stringify({ p, picked }).slice(0, 300));
        const bad = await call('browser_press', { keys: 'Hyper+Q' });
        check('C50-S1 browser_press refuses a key it does not know, with the list', bad?.ok === false && /Enter/.test(JSON.stringify(bad)));
      }
    } finally {
      await call('browser_close').catch(() => {});
      srv.close();
      if (saved.chromePath === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = saved.chromePath;
      if (saved.headless === undefined) delete process.env.BROWSER_HEADLESS; else process.env.BROWSER_HEADLESS = saved.headless;
      if (saved.allowPrivate === undefined) delete process.env.ALLOW_PRIVATE; else process.env.ALLOW_PRIVATE = saved.allowPrivate;
    }
  }

  // --- the balance's own drop (the 11-14..20 bill: other keys and evaluation spend too) ------
  {
    const h = 3600 * 1000;
    const t0 = Date.UTC(2026, 10, 18, 4);
    const steady = [{ at: t0, amount: 60 }, { at: t0 + 24 * h, amount: 55 }, { at: t0 + 48 * h, amount: 50.5 }];
    const p = U.balancePace(steady, t0 + 48 * h);
    const topUp = U.balancePace([{ at: t0, amount: 60 }, { at: t0 + 10 * h, amount: 58 }, { at: t0 + 12 * h, amount: 158 }, { at: t0 + 40 * h, amount: 152 }], t0 + 40 * h);
    const tooSoon = U.balancePace([{ at: t0, amount: 60 }, { at: t0 + 5 * h, amount: 59 }], t0 + 5 * h);
    check('C50-B7 「还能用几天」 by the balance\'s own drop once two readings are a day apart (¥60 → ¥50.5 in 48 h is ¥4.75 a day); a top-up starts it again; under 20 hours, none',
      p?.perDay === 4.75 && topUp?.perDay === 5.14 && tooSoon === null, JSON.stringify({ p, topUp, tooSoon }));
    const kept = U.noteBalance(50.52, t0 + 49 * h, steady);
    const again = U.noteBalance(50.4, t0 + 49.5 * h, kept);
    check('C50-B7 readings are kept, one per hour (a newer one in the same hour replaces it)', kept.length === 4 && again.length === 4 && again[3].amount === 50.4);
    const SV = await import('../src/server.mjs');
    const serverSrc = await readText('../src/server.mjs');
    check('C50-B7 the checkup says which pace it used: the balance\'s drop (every app and key on the account) or the ledger\'s (without evaluation runs)',
      /按账户余额最近每天约 ¥4\.75 的下降/.test(SV.balanceVerdict(50.52, 4.75, 'balance').text) && /大约还能用 10 天/.test(SV.balanceVerdict(50.52, 4.75, 'balance').text)
      && serverSrc.includes('balancePace(noteBalance(cny))'));
    await fsp.rm(path.join(dataDir, 'balance-history.json'), { force: true });
  }

  // --- what the beginner test found (11-20) ------------------------------------------------
  {
    const rp = { prices: { m: { in: 2, out: 8, cached: 0.04 } } };
    const evalRow = U.summarizeUsage([{ day: '2026-11-19', botId: 'bot-x', botName: '跑分员', eval: true, model: 'm', prompt: 10, completion: 0, total: 10, cached: 0 }], rp).byBot[0];
    const apps = await readText('../public/app/main/09-apps.js');
    check('BT50-1 a bot made with eval: true (any name) is in the 评测 row of 按机器人, not a row of its own',
      evalRow.eval === true && apps.includes('Boolean(row.eval) ||'));
    const d1 = (await api('/api/usage?days=1')).json?.spendRate;
    const d30 = (await api('/api/usage?days=30')).json?.spendRate;
    check('BT50-2 「最近每天约」 is the checkup\'s number whatever range is shown (「今天」 read ¥0.03 for ¥0.98)',
      JSON.stringify(d1) === JSON.stringify(d30) && (await readText('../src/server.mjs')).includes('summary.spendRate = spendRate(recentRecords(all, 7), settings);'), JSON.stringify({ d1, d30 }));
    const rt = await readText('../public/app/main/07-skills-routines.js');
    check('BT50-3/7 a routine waiting for off-peak shows the time it really runs (「下次 周一 12:00（闲时）」); the button says what it changes to (改成…); the option shows only where the model has peak hours',
      rt.includes('`下次 ${fmtRunAt(rt.nextRun)}（闲时）`') && rt.includes("'改成到点就跑' : '改成闲时再跑'") && rt.includes('if (rt.offPeak || peakPriced()) actions.appendChild(cheap);') && rt.includes('offPeakRow.hidden = !peakPriced();'));
    const recs = [{ completion: 1000, reasoning: 5, prompt: 1, total: 1001, model: 'm', day: 'd' }, { completion: 9000, prompt: 1, total: 9001, model: 'm', day: 'd' }];
    const t4 = U.summarizeUsage(recs, rp).totals;
    check('BT50-4 the thinking share counts only the calls that say how much was thinking (older ones are left out); under 1% says so',
      t4.reasoningOf === 1000 && t4.reasoning === 5 && apps.includes("'不到 1% 的输出'"), JSON.stringify(t4));
    await fsp.writeFile(settingsPath, JSON.stringify({ currency: 'CNY', prices: { 'deepseek-flash': { in: 2, out: 8, cached: 0.04, peak: false } } }));
    const optedOut = U.readUsageSettings().prices['deepseek-flash'];
    check('BT50-5 a peak box the human unticked stays unticked (peak: false is kept); the page sends it and says what it means',
      optedOut.peak === false && apps.includes('prices[name] = { in: Number(inRaw) || 0, out: Number(outRaw) || 0, ...(cachedRaw ? { cached: Number(cachedRaw) || 0 } : {}), peak };') && apps.includes('没勾峰谷价'), JSON.stringify(optedOut));
    const SV = await import('../src/server.mjs');
    const t6 = SV.balanceVerdict(50.52, 4.62, 'balance', 0.98).text;
    check('BT50-6 when the balance drops faster than Lamplit\'s own record, the checkup says what the rest is (other apps, other keys, evaluation)',
      /Lamplit 自己记的是每天约 ¥0\.98/.test(t6) && /别的应用、别的密钥或评测/.test(t6) && !/Lamplit 自己记的/.test(SV.balanceVerdict(50.52, 1.0, 'balance', 0.98).text), t6);
  }

  // --- the checkup and the cost page say it in plain words ----------------------------------
  {
    const apps = await readText('../public/app/main/09-apps.js');
    const serverSrc = await readText('../src/server.mjs');
    check('C50 the cost page lists evaluation apart (不算进每天的花费) and the other kinds of calls (看图, 规则判断, 翻译, 连通测试) by name',
      apps.includes('不算进每天的花费') && apps.includes('看图') && apps.includes('规则判断') && apps.includes('连通测试'));
    check('C50 the checkup\'s pace leaves evaluation out and says so', serverSrc.includes('不含评测'));
  }

  if (savedSettings == null) await fsp.rm(settingsPath, { force: true }); else await fsp.writeFile(settingsPath, savedSettings);
}
