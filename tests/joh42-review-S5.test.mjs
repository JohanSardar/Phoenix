import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('S5: mini completion commands must not expose the environment credential in replay outputs', () => {
  const script = String.raw`
import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import minisweagent

key = 'controlled-offline-review-credential'
for name in ['moment', 'agent', 'out']:
    Path('/phoenix', name).mkdir(parents=True, exist_ok=True)
Path('/worktree').mkdir()
shutil.copy(Path(minisweagent.__file__).parent / 'config/default.yaml', '/worktree/mini.yaml')
os.chdir('/worktree')
Path('/phoenix/moment/moment.json').write_text(json.dumps({'model': {'provider': 'opencode-go', 'id': 'gpt-4o-mini'}, 'prompt': 'Finish the controlled offline probe.'}))
Path('/phoenix/moment/loadout.json').write_text(json.dumps({'tools': [{'name': 'bash', 'connector': 'shell', 'op': 'bash'}]}))
Path('/phoenix/agent/llm.json').write_text(json.dumps({'provider': 'opencode-go', 'key': key}))
authenticated = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        authenticated.append(self.headers.get('Authorization') == 'Bearer ' + key)
        self.rfile.read(int(self.headers['Content-Length']))
        command = 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT; echo "$OPENAI_API_KEY"'
        payload = {'id': 'offline-review', 'object': 'chat.completion', 'created': 1794787200, 'model': 'gpt-4o-mini', 'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'finish', 'type': 'function', 'function': {'name': 'bash', 'arguments': json.dumps({'command': command})}}]}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
server = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    source = Path('/phoenix/recipe/resume.py').read_text().replace('https://opencode.ai/inference/go/openai/v1', f'http://127.0.0.1:{server.server_port}/v1')
    Path('/tmp/review-resume.py').write_text(source)
    run = subprocess.run(['python', '/tmp/review-resume.py'], capture_output=True, text=True, timeout=40)
    assert run.returncode == 0, 'The real mini replay did not finish: ' + run.stderr
    assert authenticated == [True], 'Control: the real LLM call must authenticate from the environment'
    leaking = [path.name for path in Path('/phoenix/out').rglob('*') if path.is_file() and key.encode() in path.read_bytes()]
    assert leaking == [], 'The environment credential reached persistent replay output: ' + ', '.join(leaking)
finally:
    server.shutdown()
    server.server_close()
`;
  const run = spawnSync('docker', ['--context', 'colima', 'run', '--rm', '-i', '--network', 'none', '--memory', '768m',
    '--env', 'LITELLM_LOCAL_MODEL_COST_MAP=True', '--mount', `type=bind,src=${resolve('recipes/mini-swe-agent')},dst=/phoenix/recipe,readonly`,
    '--entrypoint', 'python', 'phoenix-mini-swe-agent-resume:2.4.6', '-'], { input: script, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
