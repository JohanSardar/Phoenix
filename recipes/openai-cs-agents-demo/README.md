# OpenAI customer service agents demo

[openai/openai-cs-agents-demo](https://github.com/openai/openai-cs-agents-demo) is OpenAI's airline customer service demo: a triage agent hands off to flight, booking, seat, refund and FAQ agents, each with its own tools. It keeps no session, so it has no resume.

The harness is the demo's `python-backend` folder. A replay starts at the first message with the moment's prompt. resume.py runs the triage agent once, Phoenix answers every function tool, and every agent uses the moment's LLM. The LLM is reached directly at its own host. On the `openai-codex` route the ChatGPT backend answers only streamed requests, so resume.py streams every request, the guardrails' included.

## LLM routes

The moment's `llm` picks the route:

- `opencode-go` uses the OpenCode Go key OpenCode keeps on this machine, at opencode.ai.
- `openai-codex` uses pi's ChatGPT login on this machine, at chatgpt.com. The model id is a Codex one, such as `gpt-6.1-terra`. The login must stay valid for 15 more minutes; if not, run pi once to refresh it.

Before the box starts, login.mjs sends the LLM one short request with the login. If the LLM refuses or can't be reached, the replay does not run, and no check verdict is given. The sample says why, for example "the harness's LLM at opencode.ai refused (HTTP 402): insufficient balance". If the LLM fails later, partway through the run, the harness exits with an error and the sample fails.

Moments for it are made up. Name each tool the moment's world answers under `tools`, with the service that answers it:

```yaml
tools:
  - { name: cancel_flight, service: airline, description: Cancel a flight., parameters: { type: object } }
world:
  - tool: airline.cancel_flight
    answer: "Flight PA441 successfully cancelled for confirmation IR-D204"
```

Build the box image with `docker build -f resume.Dockerfile -t phoenix-cs-demo-resume:bd7bfca0 .` from this folder.
