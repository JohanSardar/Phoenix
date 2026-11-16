"""mini-swe-agent environment for a Phoenix replay: Phoenix answers every bash command.

mini-swe-agent's own finish command runs in the box, because it is how the agent says it is done, not a call to the world.
"""
import json
import os
import urllib.request

from minisweagent.environments.local import LocalEnvironment

FINISH = "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
LOADOUT = json.load(open("/phoenix/moment/loadout.json"))
BASH = next(tool for tool in LOADOUT["tools"] if tool["name"] == "bash")


class PhoenixEnvironment(LocalEnvironment):
    calls = 0

    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict:
        command = action.get("command", "")
        if command.strip().startswith(FINISH):
            return super().execute(action, cwd, timeout=timeout)
        PhoenixEnvironment.calls += 1
        body = json.dumps({"jsonrpc": "2.0", "id": PhoenixEnvironment.calls, "method": "tools/call", "params": {"name": BASH["op"], "arguments": {"command": command}}}).encode()
        request = urllib.request.Request(f"{os.environ['PHOENIX_TOOLS_URL']}/{BASH['connector']}", data=body, headers={"content-type": "application/json"})
        reply = json.load(urllib.request.urlopen(request))
        if "result" not in reply:
            raise RuntimeError(reply.get("error", {}).get("message", "Phoenix did not answer"))
        result = reply["result"]
        output = "".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
        return {"output": output, "returncode": 1 if result.get("isError") else 0, "exception_info": ""}
