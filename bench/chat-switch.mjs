#!/usr/bin/env node
// What one simple prompt costs in a long chat: on the chat's own warm model, or moved to a cheaper one.
// It builds a chat of about --tokens tokens on Opus (one message holding a slice of hooks/register.tsx), which writes the
// chat to Opus's prompt cache. Then it asks the same short question in a fork of that chat on each model: Opus (stay),
// Haiku and Sonnet. The first ask on another model has a cold cache there; the second ask on it is warm.
// Usage: node bench/chat-switch.mjs [--tokens 80000] [--chat opus]
// Needs the `claude` CLI logged in. No tools, no MCP, no plugins. One run at 80,000 tokens costs about $1 at list price.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const TOKENS = Number(flag('tokens', '80000'))
const CHAT = flag('chat', 'opus')
// Measured on this file with Opus 5.5: about 2.27 characters to a token.
const CHARS_PER_TOKEN = 2.27
const QUESTION = 'One short question, no need to look at the file: what is 17 times 23? Reply with the number only.'
const RIGHT = '391'

// The CLI's `haiku` shortcut still answers with Haiku 4.5, so Haiku is asked for by its full name.
const MODEL_ID = { haiku: 'claude-haiku-5-5' }
// Dollars per million tokens (input, 1-hour cache write, cache read, output), from Anthropic's pricing page on 2026-11-14.
// The CLI's own total_cost_usd does not know Haiku 5.5, so the cost is worked out from the tokens each request reports.
const PRICE = { haiku: [0.1, 0.2, 0.01, 0.5], sonnet: [2, 4, 0.1, 10], opus: [4, 8, 0.2, 20], fable: [8, 16, 0.2, 40] }
function costOf(modelId, u = {}) {
  const key = Object.keys(PRICE).find(k => modelId.includes(k))
  if (!key) return NaN
  const input = u.input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, out = u.output_tokens ?? 0
  const times = key === 'haiku' && input + write + read > 100_000 ? 5 : 1
  const [pi, pw, pr, po] = PRICE[key]
  return times * (input * pi + write * pw + read * pr + out * po) / 1e6
}

function ask(model, prompt, resume) {
  return new Promise((resolve, reject) => {
    const argv = ['-p', '--model', MODEL_ID[model] ?? model, '--effort', 'low', '--disable-slash-commands', '--tools', '',
      '--system-prompt', 'You are a helpful assistant.', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json',
      ...(resume ? ['--resume', resume, '--fork-session'] : [])]
    const p = spawn('claude', argv, { cwd: tmpdir() })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (j.is_error) return reject(new Error(j.result))
        // A resumed chat lists the models of its earlier requests first: the one that answered this request is last.
        const resolved = Object.keys(j.modelUsage ?? {}).at(-1) ?? model
        const u = j.usage ?? {}
        resolve({
          session: j.session_id, model: resolved, answer: String(j.result).trim(), ms: j.duration_ms ?? 0,
          input: u.input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          read: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0, cost: costOf(resolved, u),
        })
      } catch { reject(new Error(`bad output: ${out.slice(0, 200)} ${err.slice(0, 200)}`)) }
    })
    p.stdin.end(prompt)
  })
}

const file = readFileSync(join(here, '..', 'hooks', 'register.tsx'), 'utf8').slice(0, Math.round(TOKENS * CHARS_PER_TOKEN))
const rows = []
const note = (step, r) => { rows.push({ step, ...r }); console.error(`${step}: ${r.model} wrote ${r.write} read ${r.read} out ${r.out} $${r.cost.toFixed(4)} -> ${r.answer.slice(0, 40)}`) }

// The chat: one long message, answered on the chat's model. This writes the chat to that model's cache.
const chat = await ask(CHAT, `Here is a source file. Read it; questions come later. Reply with only: OK\n\n${file}`)
note(`build the chat on ${CHAT}`, chat)
// Stay, twice: the chat is read from the warm cache.
note(`stay on ${CHAT}, 1`, await ask(CHAT, QUESTION, chat.session))
note(`stay on ${CHAT}, 2`, await ask(CHAT, QUESTION, chat.session))
// Move: the first prompt on the other model writes the chat to its cache; the next one reads it.
for (const m of ['haiku', 'sonnet'].filter(m => m !== CHAT)) {
  const cold = await ask(m, QUESTION, chat.session)
  note(`move to ${m}, cold`, cold)
  note(`move to ${m}, warm`, await ask(m, QUESTION, chat.session))
}

const stay = (rows[1].cost + rows[2].cost) / 2
const md = [
  `Chat-switch benchmark ${new Date().toISOString().slice(0, 16)}Z. A chat of about ${TOKENS} tokens built on ${CHAT}, then one short question asked in a fork of it on each model. Dollars are worked out from the tokens at the list prices of 2026-11-14.`,
  '', '| Step | Model that answered | Fresh input | Cache write | of it 1-hour | Cache read | Output | Cost | Against staying | Right answer |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r, i) => `| ${r.step} | ${r.model} | ${r.input} | ${r.write} | ${r.write1h} | ${r.read} | ${r.out} | $${r.cost.toFixed(4)} | ${i === 0 ? '-' : `${(r.cost / stay).toFixed(2)}x`} | ${i === 0 ? '-' : r.answer.includes(RIGHT) ? 'yes' : `NO: ${r.answer.slice(0, 30)}`} |`),
  '', `Staying costs $${stay.toFixed(4)} a prompt (the mean of the two).`,
].join('\n')
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', `chat-switch-${TOKENS}-${stamp}.json`), JSON.stringify(rows, null, 1))
writeFileSync(join(here, 'results', `chat-switch-${TOKENS}-${stamp}.md`), md + '\n')
console.log(md)
