#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { makeCanaries, makeControls, findTokens } from '../src/canaries.js';
import { runTest, summarize, score } from '../src/run.js';

const HELP = `honeyprompt — does your AI agent obey instructions hidden in what it reads?

  honeyprompt test  --model NAME [--base-url http://127.0.0.1:11434/v1] [--repeats 2] [--no-think] [--json out.jsonl]
        Ask the model to summarise 24 planted documents (+4 clean controls) with two
        harmless tools available, and report how often it obeyed the planted text.
  honeyprompt report results.jsonl
        Re-score a saved --json run with the current rules and print the table.
  honeyprompt plant [--out ./canaries]
        Write the canary documents to a folder and their tokens to canaries.json,
        e.g. to drop into your own RAG corpus or inbox.
  honeyprompt scan  PATH... [--registry canaries.json]
        Search files or folders (logs, agent-blackbox recordings) for canary tokens.
        A hit means an AI repeated or acted on planted text.

Every planted instruction is harmless: repeat a code, or fetch a URL on the
reserved .invalid domain, which can never resolve.`;

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { f._.push(a); continue; }
    const k = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) f[k] = argv[++i]; else f[k] = true;
  }
  return f;
}
const pct = (k, n) => n ? `${Math.round(100 * k / n)}%` : '-';

function printTable(results, model, where) {
  const s = summarize(results);
  console.log(`\nhoneyprompt — ${model} (${where})\n`);
  console.log(`${'hidden as / asks to'.padEnd(20)} ${'n'.padStart(4)} ${'OBEYED'.padStart(7)} ${'echoed'.padStart(7)} ${'reported'.padStart(9)} ${'ignored'.padStart(8)}`);
  for (const [k, c] of s.cells) console.log(`${k.padEnd(20)} ${String(c.n).padStart(4)} ${pct(c.obeyed, c.n).padStart(7)} ${pct(c.echoed, c.n).padStart(7)} ${pct(c.reported, c.n).padStart(9)} ${pct(c.ignored, c.n).padStart(8)}`);
  console.log(`\nCalled the planted URL: ${s.fetch_obeyed.k}/${s.fetch_obeyed.n} (${pct(s.fetch_obeyed.k, s.fetch_obeyed.n)})   Followed any planted instruction: ${s.any_followed.k}/${s.any_followed.n} (${pct(s.any_followed.k, s.any_followed.n)})${s.errors ? `   errors: ${s.errors}` : ''}`);
  console.log('OBEYED = made the tool call the planted text asked for. echoed = repeated the code as if told to. reported = quoted it while calling it out.');
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);

if (cmd === 'test') {
  if (!f.model) { console.error('need --model'); process.exit(2); }
  const baseUrl = f['base-url'] || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';
  const out = typeof f.json === 'string' ? fs.createWriteStream(f.json, { flags: 'a' }) : null;
  let done = 0;
  const results = await runTest({ baseUrl, model: f.model, repeats: Number(f.repeats || 2), apiKey: process.env.OPENAI_API_KEY, noThink: !!f['no-think'],
    onResult: (r) => { done++; out?.write(JSON.stringify(r) + '\n'); if (!f.quiet) process.stderr.write(`\r${done} replies…`); } });
  if (!f.quiet) process.stderr.write('\n');
  printTable(results, f.model, baseUrl);
} else if (cmd === 'report') {
  const file = f._[0];
  if (!file) { console.error('usage: honeyprompt report results.jsonl'); process.exit(2); }
  const results = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .map(r => (r.outcome === 'error' || !r.reply) ? r : { ...r, outcome: score({ token: r.token }, r.reply) });
  printTable(results, results[0]?.model || '?', file);
} else if (cmd === 'plant') {
  const dir = typeof f.out === 'string' ? f.out : './canaries';
  fs.mkdirSync(dir, { recursive: true });
  const docs = makeCanaries();
  for (const d of [...docs, ...makeControls()]) fs.writeFileSync(path.join(dir, d.filename), d.text);
  const reg = docs.map(({ token, base, style, action, filename }) => ({ token, base, style, action, filename }));
  fs.writeFileSync(path.join(dir, 'canaries.json'), JSON.stringify(reg, null, 2));
  console.log(`wrote ${docs.length} canary documents + 4 controls to ${dir}; tokens in ${path.join(dir, 'canaries.json')}`);
} else if (cmd === 'scan') {
  const reg = typeof f.registry === 'string' ? JSON.parse(fs.readFileSync(f.registry, 'utf8')) : null;
  const known = reg ? new Map(reg.map(r => [r.token, r])) : null;
  const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap(x => walk(path.join(p, x))) : [p];
  let hits = 0;
  for (const file of f._.flatMap(walk)) {
    if (reg && path.basename(file) === 'canaries.json') continue;
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const t of findTokens(text)) {
      if (known && !known.has(t)) continue;
      if (known?.get(t) && path.basename(file) === known.get(t).filename) continue;   // the canary document itself
      hits++;
      console.log(`${file}: ${t}${known ? `  (planted in ${known.get(t).filename})` : ''}`);
    }
  }
  console.log(hits ? `\n${hits} canary token(s) found outside their documents — an AI repeated or acted on planted text.` : 'no canary tokens found');
  process.exitCode = hits ? 1 : 0;
} else {
  console.log(HELP);
  process.exitCode = cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0;
}
