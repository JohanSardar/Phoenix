import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export async function forkCommand(t, { shell, workdir }) {
  const scratch = join(homedir(), '.capy/work/joh52-sol/round1');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-15T12:00:00.000Z';
  const cwd = '/synthetic-project';
  const command = 'printf actual-execution > /phoenix/out/command-ran; printf actual-execution';
  const row = (type, payload) => ({ timestamp, type, payload });
  const rows = [
    row('session_meta', { id: '00000000-0000-4000-8000-000000000001', timestamp, cwd, cli_version: '0.169.0', account_scoped: true, model_provider: 'review', source: 'exec', originator: 'codex_exec', base_instructions: { text: 'Synthetic review session.' } }),
    row('turn_context', { cwd, model: 'synthetic' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the recorded command.' }] }),
    row('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'user', content: [{ type: 'text', text: 'Run the recorded command.' }] } }),
    row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'command', command: [shell ?? '/bin/zsh', '-lc', command], cwd: `file://${workdir ?? cwd}`, status: 'completed', aggregated_output: 'recorded-result', exit_code: 0 } }),
  ];
  const session = join(root, 'session.jsonl'), check = join(root, 'check.yaml'), bundle = join(root, 'bundle');
  await writeFile(session, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Return the recorded command result.\n');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'), 'moment', 'create', '--session', session, '--recipe', resolve('recipes/codex/recipe.yaml'), '--at', '3', '--id', 'shell-review', '--check', check, '--home', join(root, 'home'), bundle], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const reading = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  assert.equal(reading.answers[0].result.output, 'recorded-result');
  for (const directory of ['moment', 'agent', 'out', 'candidate']) await mkdir(join(root, directory));
  await writeFile(join(root, 'moment/cut.jsonl'), rows.slice(0, reading.cut_lines).map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(root, 'moment/loadout.json'), JSON.stringify(reading.loadout));
  await writeFile(join(root, 'moment/moment.json'), JSON.stringify({ prompt: reading.prompt }));
  const program = `
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { spawn } from 'node:child_process';
    import { writeFileSync, existsSync } from 'node:fs';
    let toolCalls = 0, requests = 0, observed = '';
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks));
      if (req.url === '/codex-shell') {
        toolCalls++; res.end(JSON.stringify({ jsonrpc:'2.0', id:0, result:{output:'recorded-result',exit_code:0} })); return;
      }
      requests++;
      const output = body.input?.findLast(item => item.type === 'function_call_output');
      if (output) observed = typeof output.output === 'string' ? output.output : JSON.stringify(output.output);
      const item = output || requests > 1
        ? {type:'message',id:'msg_review',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic completion.',annotations:[]}]}
        : {type:'function_call',id:'fc_review',call_id:'call_review',name:'exec_command',arguments:JSON.stringify(${JSON.stringify({ cmd: command, ...(shell ? { shell } : {}), ...(workdir ? { workdir } : {}) })}),status:'completed'};
      const response = {id:'resp_review',object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
      res.writeHead(200, {'content-type':'text/event-stream'});
      for (const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}]) res.write('event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n');
      res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    writeFileSync('/worktree/config.toml', '[model_providers.review]\\nbase_url="http://127.0.0.1:'+port+'/v1"\\nrequires_openai_auth=false\\n');
    const child = spawn('node', ['/phoenix/recipe/resume.mjs'], {env:{...process.env,PHOENIX_TOOLS_URL:'http://127.0.0.1:'+port},stdio:['ignore','pipe','pipe']});
    let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    const [code] = await once(child, 'close'); server.closeAllConnections(); server.close();
    console.log(JSON.stringify({code,toolCalls,requests,observed,executed:existsSync('/phoenix/out/command-ran'),log}));
  `;
  const mounts = [['moment', '/phoenix/moment'], ['agent', '/phoenix/agent'], ['out', '/phoenix/out'], ['candidate', '/worktree']].flatMap(([source, target]) => ['--mount', `type=bind,source=${join(root, source)},target=${target}`]);
  const run = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', ...mounts, '--mount', `type=bind,source=${resolve('recipes/codex')},target=/phoenix/recipe,readonly`, 'phoenix-codex-resume:0.169.0', 'node', '--input-type=module', '-'], { input: program, env: { ...process.env, DOCKER_HOST: 'unix:///Users/johansardar/.colima/default/docker.sock' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 5_000_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(result.code, 0, result.log);
  console.log({ toolCalls: result.toolCalls, executed: result.executed, observed: result.observed });
  return result;
}
