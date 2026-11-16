# OpenAI customer service agents demo

[openai/openai-cs-agents-demo](https://github.com/openai/openai-cs-agents-demo) is OpenAI's airline customer service demo: a triage agent hands off to flight, booking, seat, refund and FAQ agents, each with its own tools. It keeps no session, so it has no resume.

The harness is the demo's `python-backend` folder. A replay starts at the first message with the moment's prompt. resume.py runs the triage agent once, Phoenix answers every function tool, and every agent uses the moment's LLM. The LLM is reached directly at its own host.

Moments for it are made up. Name each tool the moment's world answers under `tools`, with the service that answers it:

```yaml
tools:
  - { name: cancel_flight, service: airline, description: Cancel a flight., parameters: { type: object } }
world:
  - tool: airline.cancel_flight
    answer: "Flight PA441 successfully cancelled for confirmation IR-D204"
```

Build the box image with `docker build -f resume.Dockerfile -t phoenix-cs-demo-resume:bd7bfca0 .` from this folder.
