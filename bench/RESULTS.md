# Benchmarks

Three benchmarks, each one you can run again. None is a lab result: small task sets, few runs. Read the limits under each.

## 1. How much does effortless save? (`bash bench/agentic/run.sh`)

The question people ask: same work, with effortless on and with it off, what does it cost and is the answer still right?

Four coding tasks in a fresh copy of this repo: find and explain a setting, add doc comments without touching code, write and run a small script, and trace a flow through several files. Each ran 3 times per setup, on Opus 5.5 and Sonnet 5.5, through Anthropic's API (an API key, so the cost is real list price). Without effortless the app sat at medium, high or xhigh. With it, the app started on medium and effortless picked the effort for each prompt. Every answer was checked: the right fact, no file touched that should not be, the script printing the right number. Run 2026-10-10, 96 runs.

**Opus 5.5**

| Setup | Correct | Cost per task | Requests per task | Time per task |
| --- | --- | --- | --- | --- |
| medium (Anthropic's recommendation), no effortless | 12 of 12 | $0.190 | 7.3 | 24 s |
| high, no effortless | 12 of 12 | $0.209 | 8.0 | 27 s |
| xhigh, no effortless | 12 of 12 | $0.257 | 9.9 | 44 s |
| **effortless on** | **12 of 12** | **$0.149** | **5.8** | **20 s** |

effortless saved **21%** against medium, **29%** against high and **42%** against xhigh, with every answer still right. It picked low 9 times and medium 3 times.

**Sonnet 5.5**

| Setup | Correct | Cost per task | Requests per task | Time per task |
| --- | --- | --- | --- | --- |
| medium, no effortless | 12 of 12 | $0.092 | 6.4 | 15 s |
| high, no effortless | 12 of 12 | $0.107 | 8.8 | 20 s |
| xhigh, no effortless | 12 of 12 | $0.146 | 11.4 | 31 s |
| **effortless on** | **12 of 12** | **$0.096** | **7.5** | **18 s** |

On Sonnet it came out even against medium (4% more, inside the noise), and saved **10%** against high and **35%** against xhigh.

What it says:
- The saving comes from fewer steps, not only less thinking. Every request rereads the whole chat, and at low effort the model took fewer of them (5.8 against 7.3 on Opus medium).
- It is faster too: 20 s per task against 24 s on Opus medium.
- Sonnet at medium is already lean, so there is little to take off it.

Limits:
- Four tasks, three runs each. The percentages could move a few points on a rerun.
- Mostly easy tasks, where effortless goes low and saves the most. On hard tasks it picks more effort and saves less; not measured here.
- The checks test the right fact, file or number, not how well an answer is written.
- Fresh chats through the API. Long chats in the app, and plan usage, were not measured.
- The judge (Haiku) adds about $0.001 to $0.002 per prompt and is not in the figures.

Every run: `bench/results/agentic-2026-10-10.md` and `.json`.

## 2. Is the judge right? (`/effortless bench`)

73 hand-labelled prompts (20 held out), version 1.5.1. A case is "right" when the judge's effort is one a careful person would accept.

| Judge | Right | Held out |
| --- | --- | --- |
| always medium | 44% | 40% |
| always high | 51% | 50% |
| Haiku | 93% | 95% |
| Jev | 99% | 100% |

Prompts and labels: `bench/judge-cases.json`.

## 3. Why model switching is off (`node bench/quality.mjs`, `node bench/chat-switch.mjs`)

**Cheaper model when it can** moves a simple prompt to Haiku or Sonnet. Two things decide whether that is worth it: are the cheaper answers good enough, and what does the move cost in a real chat. Both were measured again on 2026-11-14 on Opus 5.5, Sonnet 5.5 and Haiku 5.5, one run each.

Dollars in this section are worked out from the tokens each request reported and the list prices on Anthropic's pricing page on 2026-11-14. The `claude` CLI's own cost figure is not used: it does not know Haiku 5.5 and prices it as Opus. The CLI's `haiku` shortcut also still answers with Haiku 4.5, so both scripts ask for Haiku 5.5 by its full name.

### Are the cheaper answers good enough?

30 self-contained prompts, each answered on Opus high and on the model and effort a router would pick (Haiku low for easy, Sonnet medium for normal, Opus high for hard), compared by a blind grader (Opus, high effort).

| Against Opus high | Routed as good or better | Routed good enough | Baseline cost | Routed cost | Saved |
| --- | --- | --- | --- | --- | --- |
| easy (12, Haiku low) | 25% | 92% | $0.121 | $0.003 | 98% |
| normal (12, Sonnet medium) | 58% | 100% | $0.373 | $0.109 | 71% |
| hard (6, same model) | 100% | 100% | $0.996 | $0.996 | 0% |
| all (30) | 53% | 97% | $1.490 | $1.107 | 26% |

- The grader preferred the Opus answer in 9 of 12 easy prompts and 5 of 12 normal ones, and never preferred the cheaper answer. Mostly Opus was more complete, not more correct.
- "Good enough" means a person who got only the cheaper answer would not need to ask again and would not be misled. That held for 29 of 30.
- The one miss was on Haiku: a PowerShell line count that silently skips blank lines, with no warning.
- In October's run the easy prompts were good enough in 83% (10 of 12) and saved 78%.

### What does the move cost in a real chat?

Each model keeps its own prompt cache. A prompt moved to another model has to write the whole chat into that model's cache first, at twice the input price (Claude Code writes the 1-hour cache: every write in these runs was a 1-hour one). The next prompt on that model reads it from the cache.

A chat was built on Opus from one long message, then the same short question was asked in a fork of it on each model. Every answer was right.

| One simple prompt | 95,000-token chat | Against staying | 118,000-token chat | Against staying |
| --- | --- | --- | --- | --- |
| stay on warm Opus (mean of 2) | $0.0225 | 1x | $0.0271 | 1x |
| move to Haiku, cold | $0.0191 | 0.85x | $0.1183 | 4.4x |
| move to Haiku, warm | $0.0010 | 0.04x | $0.0061 | 0.23x |
| move to Sonnet, cold | $0.3818 | 17x | $0.4734 | 17.5x |
| move to Sonnet, warm | $0.0105 | 0.47x | $0.0128 | 0.47x |

- **Haiku, chat up to 100,000 tokens:** the first prompt on a cold Haiku costs a little less than staying, and every prompt after it costs about a 25th.
- **Haiku, chat over 100,000 tokens:** Haiku 5.5 charges five times as much there, so the first prompt costs about 4.4 times what staying does. By these figures it is paid back after about 5 more prompts on Haiku.
- **Sonnet:** the first prompt costs 17 times what staying does, and each later one saves about a cent. It takes about 30 prompts on Sonnet to pay that back.

On 2026-10-10 the same measurement on an 80k-token chat found Haiku at about 5 times the cost of staying and Sonnet at about 10 times. Haiku 5.5's list price is now far lower, and effortless's own price table was out of date; it was corrected in the same change as this run.

Limits:
- One run, one question, a chat made of one long message. A real chat has many turns and tool calls.
- The dollars are tokens times list price, not a bill. That Haiku 5.5 costs five times as much over 100,000 tokens is taken from the pricing page, not measured.
- Not measured: the chat going back to Opus afterwards, and the Opus cache running out while prompts are on Haiku.
- The quality prompts start with no chat history. How well Haiku answers a simple prompt deep in a long chat was checked only by the one sum above.
- One grader, one run: the percentages can move by a prompt or two.

These runs say a move to Haiku in a chat under 100,000 tokens now pays, at the price of answers that are good enough but usually less complete; a move to Sonnet does not, unless many prompts in a row stay there. The saving is small: staying cost about 2 cents a simple prompt.

This fork took **Cheaper model when it can** out of the settings on 2026-11-14, after these runs: a saved "on" is ignored and every prompt runs on the chat's own model. The routing code and its cost sums are still in `hooks/register.tsx`, unused, so the original's updates still merge. In the original the setting is off by default and marked experimental.

Details: `bench/results/quality-202611150335.md`, `chat-switch-95000-202611150329.md` and `chat-switch-120000-202611150330.md`, with the .json beside each. October's runs: `quality-202610091528.md` (vs high) and `quality-202610091911-vs-opus-medium.md`.
