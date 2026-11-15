#!/usr/bin/env node
// Answer-quality benchmark. For each prompt in quality-cases.json: answer it on Opus (high effort) and on the model and
// effort a router would pick, then let a blind grader (Opus, high) compare the two answers in random order.
// Usage: node bench/quality.mjs [--only e01,n02] [--grader opus] [--jobs 4] [--base opus:high]
// Needs the `claude` CLI logged in. Runs are headless with no tools, no MCP and no plugins, so cost is the prompt and answer only.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const only = flag('only', '')?.split(',').filter(Boolean)
const GRADER = flag('grader', 'opus')
const JOBS = Number(flag('jobs', '4'))
const BASE = flag('base', 'opus:high').split(':')

const cases = JSON.parse(readFileSync(join(here, 'quality-cases.json'), 'utf8')).cases.filter(c => !only?.length || only.includes(c.id))

// The CLI's `haiku` shortcut still answers with Haiku 4.5, so Haiku is asked for by its full name.
const MODEL_ID = { haiku: 'claude-haiku-5-5' }
// Dollars per million tokens (input, 1-hour cache write, cache read, output), from Anthropic's pricing page on 2026-11-14.
// The cost is worked out from the tokens each answer reports: the CLI's own total_cost_usd does not know Haiku 5.5 and
// prices it as Opus. Haiku 5.5 costs five times as much in a request whose prompt is over 100,000 tokens.
const PRICE = { haiku: [0.1, 0.2, 0.01, 0.5], sonnet: [2, 4, 0.1, 10], opus: [4, 8, 0.2, 20], fable: [8, 16, 0.2, 40] }
export function costOf(modelId, u = {}) {
  const key = Object.keys(PRICE).find(k => modelId.includes(k))
  if (!key) return NaN
  const input = u.input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, out = u.output_tokens ?? 0
  const times = key === 'haiku' && input + write + read > 100_000 ? 5 : 1
  const [pi, pw, pr, po] = PRICE[key]
  return times * (input * pi + write * pw + read * pr + out * po) / 1e6
}

function ask(model, effort, prompt) {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--model', MODEL_ID[model] ?? model, '--effort', effort, '--no-session-persistence', '--disable-slash-commands', '--tools', '',
      '--system-prompt', 'You are a helpful assistant.', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json']
    const p = spawn('claude', argv, { cwd: tmpdir(), shell: process.platform === 'win32' ? false : false })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (j.is_error) return reject(new Error(j.result))
        const resolved = Object.keys(j.modelUsage ?? {})[0] ?? model
        resolve({ text: j.result, cost: costOf(resolved, j.usage), ms: j.duration_ms ?? 0, resolved, out: j.usage?.output_tokens ?? 0 })
      } catch { reject(new Error(`bad output: ${out.slice(0, 200)} ${err.slice(0, 200)}`)) }
    })
    p.stdin.end(prompt)
  })
}

const GRADE = (q, a, b) => `You are grading two answers to the same question. You do not know who wrote them.
Judge correctness first, then completeness, then clarity. Ignore length and polish unless it changes how useful the answer is.
Say "tie" when a careful reader would be equally well served by either.
Also say whether the worse answer is still good enough: a user who got only that answer would not need to ask again and would not be misled.

QUESTION:
${q}

ANSWER A:
${a}

ANSWER B:
${b}

Reply with one JSON object and nothing else: {"winner":"A"|"B"|"tie","worse_is_ok":true|false,"reason":"one sentence"}`

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }))
  return out
}

const rows = await pool(cases, JOBS, async c => {
  const same = c.route[0] === BASE[0] && c.route[1] === BASE[1]
  try {
    const base = await ask(BASE[0], BASE[1], c.prompt)
    const routed = same ? base : await ask(c.route[0], c.route[1], c.prompt)
    let verdict = { winner: 'tie', ok: true, reason: 'same model and effort, not graded' }, graded = false
    if (!same) {
      const flip = Math.random() < 0.5 // flip: routed shown as A
      const g = await ask(GRADER, 'high', GRADE(c.prompt, flip ? routed.text : base.text, flip ? base.text : routed.text))
      const m = g.text.match(/\{[\s\S]*\}/)
      const v = m ? JSON.parse(m[0]) : { winner: 'tie', worse_is_ok: true, reason: 'unparseable' }
      const w = v.winner === 'tie' ? 'tie' : ((v.winner === 'A') === flip ? 'routed' : 'baseline')
      verdict = { winner: w, ok: w !== 'baseline' || v.worse_is_ok !== false, reason: v.reason }; graded = true
    }
    console.error(`${c.id} ${c.route.join('/')} -> ${verdict.winner}`)
    return { id: c.id, tier: c.tier, route: c.route, graded, ...verdict, baseCost: base.cost, routedCost: routed.cost, baseMs: base.ms, routedMs: routed.ms, baseModel: base.resolved, routedModel: routed.resolved }
  } catch (e) {
    console.error(`${c.id} failed: ${e.message}`)
    return { id: c.id, tier: c.tier, error: String(e.message) }
  }
})

const ok = rows.filter(r => !r.error)
const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0)
const median = xs => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0 }
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-'
const line = (label, rs) => {
  const w = rs.filter(r => r.winner === 'routed').length, t = rs.filter(r => r.winner === 'tie').length, l = rs.filter(r => r.winner === 'baseline').length
  const bc = sum(rs, 'baseCost'), rc = sum(rs, 'routedCost')
  return `| ${label} (${rs.length}) | ${w} | ${t} | ${l} | ${pct(w + t, rs.length)} | ${pct(rs.filter(r => r.ok).length, rs.length)} | $${bc.toFixed(3)} | $${rc.toFixed(3)} | ${pct(bc - rc, bc)} |`
}
const md = [
  `Quality benchmark ${new Date().toISOString().slice(0, 16)}Z. Baseline = ${BASE.join(' ')} for every prompt. Routed = the model and effort in the case file. Grader = ${GRADER} high, blind, random order.`,
  '', '| Tier | Routed better | Tie | Baseline better | Routed as good or better | Routed good enough | Baseline cost | Routed cost | Saved |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...['easy', 'normal', 'hard'].map(t => line(t, ok.filter(r => r.tier === t))), line('all', ok),
  '', `Median time per answer: baseline ${median(ok.map(r => r.baseMs))} ms, routed ${median(ok.map(r => r.routedMs))} ms (easy: ${median(ok.filter(r => r.tier === 'easy').map(r => r.baseMs))} vs ${median(ok.filter(r => r.tier === 'easy').map(r => r.routedMs))}; normal: ${median(ok.filter(r => r.tier === 'normal').map(r => r.baseMs))} vs ${median(ok.filter(r => r.tier === 'normal').map(r => r.routedMs))}).`,
  '', `Models that actually answered: baseline ${[...new Set(ok.map(r => r.baseModel))].join(', ')}; routed ${[...new Set(ok.map(r => r.routedModel))].join(', ')}.`,
  ...(rows.length - ok.length ? ['', `${rows.length - ok.length} case(s) failed and are left out: ${rows.filter(r => r.error).map(r => r.id).join(', ')}`] : []),
  '', '"Good enough" = routed won, tied, or lost but the grader said it would still serve the user.', '', 'Cases where baseline won:', ...ok.filter(r => r.winner === 'baseline').map(r => `- ${r.id} (${r.route.join(' ')})${r.ok ? '' : ' NOT GOOD ENOUGH'}: ${r.reason}`)
].join('\n')

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + (BASE.join('-') === 'opus-high' ? '' : `-vs-${BASE.join('-')}`)
mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', `quality-${stamp}.json`), JSON.stringify(rows, null, 1))
writeFileSync(join(here, 'results', `quality-${stamp}.md`), md + '\n')
console.log(md)
