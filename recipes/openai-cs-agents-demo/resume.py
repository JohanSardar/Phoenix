"""Runs the demo's triage agent once with the moment's prompt. Phoenix answers every function tool."""
import asyncio
import json
import os
import sys
import urllib.request
import uuid

sys.path.insert(0, os.getcwd())

from agents import Agent, FunctionTool, OpenAIChatCompletionsModel, Runner, set_tracing_disabled  # noqa: E402
from agents.exceptions import InputGuardrailTripwireTriggered  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402

import airline.agents as harness  # noqa: E402
import airline.guardrails as guardrails  # noqa: E402
from airline.context import AirlineAgentChatContext, create_initial_context  # noqa: E402

BASES = {"opencode-go": "https://opencode.ai/inference/go/openai/v1"}
moment = json.load(open("/phoenix/moment/moment.json"))
login = json.load(open("/phoenix/agent/llm.json"))
routes = {tool["name"]: tool for tool in json.load(open("/phoenix/moment/loadout.json"))["tools"]}
provider, model = moment["model"]["provider"], moment["model"]["id"]
if provider not in BASES:
    raise SystemExit(f"The demo's recipe knows no OpenAI-style address for {provider}")

set_tracing_disabled(True)
llm = OpenAIChatCompletionsModel(model=model, openai_client=AsyncOpenAI(base_url=BASES[provider], api_key=login["key"], default_headers={"x-opencode-session": str(uuid.uuid4())}))
calls = 0


def answer(name):
    route = routes.get(name, {"connector": "airline", "op": name})

    async def invoke(context, arguments):
        global calls
        calls += 1
        body = json.dumps({"jsonrpc": "2.0", "id": calls, "method": "tools/call", "params": {"name": route["op"], "arguments": json.loads(arguments or "{}")}}).encode()
        request = urllib.request.Request(f"{os.environ['PHOENIX_TOOLS_URL']}/{route['connector']}", data=body, headers={"content-type": "application/json"})
        reply = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(request)))
        if "result" not in reply:
            raise RuntimeError(reply.get("error", {}).get("message", "Phoenix did not answer"))
        return "".join(part.get("text", "") for part in reply["result"].get("content", []) if part.get("type") == "text")

    return invoke


for value in [*vars(harness).values(), *vars(guardrails).values()]:
    if not isinstance(value, Agent):
        continue
    value.model = llm
    for tool in value.tools:
        if isinstance(tool, FunctionTool):
            tool.on_invoke_tool = answer(tool.name)


async def main():
    context = AirlineAgentChatContext.model_construct(state=create_initial_context())
    try:
        result = await Runner.run(harness.triage_agent, moment["prompt"], context=context, max_turns=20)
        return {"final_text": str(result.final_output or ""), "agent": result.last_agent.name}
    except InputGuardrailTripwireTriggered as tripped:
        return {"final_text": "", "guardrail": tripped.guardrail_result.guardrail.get_name()}


outcome = asyncio.run(main())
with open("/phoenix/out/result.json", "w") as file:
    json.dump({"session": None, **outcome}, file)
