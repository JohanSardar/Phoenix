import json
import os
import subprocess
import uuid

moment = json.load(open("/phoenix/moment/moment.json"))
login = json.load(open("/phoenix/agent/llm.json"))
model = moment["model"]["id"]
if login["provider"] == "openai-codex":
    tokens = "/phoenix/agent/chatgpt"
    os.makedirs(tokens, mode=0o700, exist_ok=True)
    with open(f"{tokens}/auth.json", "w") as file:
        json.dump({"access_token": login["key"], "account_id": login["account"], "expires_at": 8.64e12}, file)
    llm = {"model_name": f"chatgpt/{model}", "model_kwargs": {"drop_params": True}}
    keys = {"CHATGPT_TOKEN_DIR": tokens}
else:
    llm = {"model_name": f"openai/{model}", "model_kwargs": {"api_base": "https://opencode.ai/inference/go/openai/v1", "extra_headers": {"x-opencode-session": str(uuid.uuid4())}, "drop_params": True}}
    keys = {"OPENAI_API_KEY": login["key"]}

phoenix = {
    "agent": {"mode": "yolo", "confirm_exit": False},
    "environment": {"environment_class": "phoenix_env.PhoenixEnvironment", "cwd": "/tmp"},
    "model": {"model_class": "litellm", "cost_tracking": "ignore_errors", **llm},
}
with open("/tmp/phoenix.yaml", "w") as file:
    json.dump(phoenix, file)
config = os.path.join(os.getcwd(), "mini.yaml")
args = ["mini", "-c", config if os.path.exists(config) else "mini.yaml", "-c", "/tmp/phoenix.yaml", "-t", moment["prompt"], "-y", "--exit-immediately", "-o", "/phoenix/out/trajectory.json"]
env = dict(os.environ) | keys | {
    "PYTHONPATH": "/phoenix/recipe", "MSWEA_CONFIGURED": "true", "MSWEA_SILENT_STARTUP": "1", "MSWEA_GLOBAL_CONFIG_DIR": "/phoenix/agent/mini",
}
code = subprocess.run(args, env=env, stdin=subprocess.DEVNULL).returncode
messages = []
if os.path.exists("/phoenix/out/trajectory.json"):
    messages = json.load(open("/phoenix/out/trajectory.json")).get("messages", [])
said = [message.get("content") for message in messages if message.get("role") == "assistant" and isinstance(message.get("content"), str) and message.get("content").strip()]
exit = next((message for message in reversed(messages) if message.get("role") == "exit"), {})
submission = exit.get("extra", {}).get("submission", "").strip()
with open("/phoenix/out/result.json", "w") as file:
    json.dump({"session": None, "final_text": submission or (said[-1] if said else ""), "exit_status": exit.get("extra", {}).get("exit_status"), "code": code}, file)
raise SystemExit(code)
