"""Runs the demo's triage agent once with the moment's prompt. Phoenix answers every function tool."""
import asyncio
import json
import os
import sys
import urllib.request
import uuid

sys.path.insert(0, os.getcwd())

from agents import Agent, FunctionTool, ModelSettings, OpenAIChatCompletionsModel, OpenAIResponsesModel, Runner, set_tracing_disabled  # noqa: E402
from agents.exceptions import InputGuardrailTripwireTriggered  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402

import airline.agents as harness  # noqa: E402
import airline.guardrails as guardrails  # noqa: E402
from airline.context import AirlineAgentChatContext, create_initial_context  # noqa: E402

moment = json.load(open("/phoenix/moment/moment.json"))
login = json.load(open("/phoenix/agent/llm.json"))
routes = {tool["name"]: tool for tool in json.load(open("/phoenix/moment/loadout.json"))["tools"]}
model = moment["model"]["id"]


class StreamedResponses(OpenAIResponsesModel):
    async def _fetch_response(self, *args, stream=False, **kwargs):
        events = await super()._fetch_response(*args, stream=True, **kwargs)
        if stream:
            return events
        async for event in events:
            if event.type == "response.completed":
                return event.response
        raise RuntimeError("The LLM's stream ended without a response")


set_tracing_disabled(True)
if login["provider"] == "openai-codex":
    llm = StreamedResponses(model=model, openai_client=AsyncOpenAI(base_url="https://chatgpt.com/backend-api/codex", api_key=login["key"], default_headers={"chatgpt-account-id": login["account"], "originator": "phoenix"}))
    settings = ModelSettings(store=False)
else:
    llm = OpenAIChatCompletionsModel(model=model, openai_client=AsyncOpenAI(base_url="https://opencode.ai/inference/go/openai/v1", api_key=login["key"], default_headers={"x-opencode-session": str(uuid.uuid4())}))
    settings = ModelSettings()
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
    value.model_settings = value.model_settings.resolve(settings)
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
