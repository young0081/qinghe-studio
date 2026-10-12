#!/usr/bin/env node
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createHarness } from './core/harness.js';
import { VERSION } from './version.js';

const providers = new Set(['responses', 'openai', 'anthropic']);
const terminals = new Set(['completed', 'failed', 'cancelled']);
const booleanOptions = new Set(['help', 'json', 'auto', 'readonly', 'open', 'version', 'browser', 'computer']);
const valueOptions = new Set(['workspace', 'session', 'provider', 'model', 'port']);
const settingKeys = new Set(['provider', 'baseUrl', 'model', 'apiKey', 'approval', 'autoApproveTools', 'modelOrchestration', 'maxTokens', 'temperature', 'systemPrompt', 'commandTimeoutMs', 'providerTimeoutMs', 'maxContextTokens', 'contextCompactionThreshold']);
const numericSettings = new Set(['maxTokens', 'temperature', 'commandTimeoutMs', 'providerTimeoutMs', 'maxContextTokens', 'contextCompactionThreshold']);

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    let argument = argv[index];
    if (literal) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      literal = true;
      continue;
    }
    if (argument === '-h') argument = '--help';
    if (argument === '-v') argument = '--version';
    if (!argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`未知选项：${argument}`);
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    if (Object.hasOwn(options, name)) throw new Error(`选项重复：--${name}`);
    if (booleanOptions.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} 不接受值`);
      options[name] = true;
    } else if (valueOptions.has(name)) {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${name} 需要一个值`);
      options[name] = value;
    } else {
      throw new Error(`未知选项：--${name}`);
    }
  }
  if (options.auto && options.readonly) throw new Error('--auto 和 --readonly 不能同时使用');
  if (options.provider && !providers.has(options.provider)) throw new Error('provider 必须是 responses、openai 或 anthropic');
  if (options.port !== undefined) options.port = integer(options.port, 'port', 0, 65535);
  return { command: positionals.shift() ?? 'help', args: positionals, options };
}

function integer(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} 必须为 ${minimum}–${maximum} 的整数`);
  return number;
}

function printHelp(output) {
  output.write(`青禾 Studio CLI ${VERSION} · AI 编程工作台\n\n用法：harness <命令> [选项]\n\n命令：\n  init [path]                    初始化项目与 .harness 状态目录\n  run <prompt>                   运行任务，流式输出答案与工具活动\n  tui                            打开终端工作台\n  gui                            打开像素风桌面 GUI\n  web [--port 3210] [--open]      打开本地 WebUI 服务\n  sessions                       列出会话\n  sessions show <id>              查看会话、消息、计划及检查点\n  sessions delete <id>            删除会话\n  config                         查看配置（隐藏密钥）\n  config set <key> <value>        更新配置\n  config test                    连接模型服务并验证当前配置\n  tools                          查看可用工具与参数\n  doctor                         检查 Node、工作区及模型配置\n\n通用选项：\n  --workspace <path>             工作区（默认当前目录）\n  --json                         输出 JSON；run 输出逐行 JSON 事件\n  -h, --help                     显示帮助\n  -v, --version                  显示版本\n\n运行选项：\n  --session <id>                 继续已有会话\n  --provider <name>              responses | openai | anthropic\n  --model <name>                 模型名\n  --auto                         自动批准工具执行\n  --browser                      本次启用独立 Browser（需要 Edge / Chrome）\n  --computer                     本次启用 Windows 桌面操作（服从审批策略）\n  --readonly                     禁止写文件、命令及电脑/网页操作\n\n模型协议：responses = OpenAI Responses；openai = OpenAI Chat；anthropic = Anthropic Messages。\n首次使用需配置模型名和 API Key，可通过 config、TUI 设置或 HARNESS_API_KEY 环境变量设置。\nconfig test 会发送一次最小模型请求，可能产生服务商费用。\n无交互终端时自动拒绝审批；需要自动批准时显式使用 --auto。Shell 审批不是操作系统沙箱。\n\n示例：\n  harness init my-project\n  harness config set provider responses\n  harness config set model "你的模型名"\n  harness config test\n  harness run "查看项目并给出建议"\n  harness tui\n`);
  output.write('\n供应商配置来源：harness config scope [workspace|global]\n不带参数查看两套配置；切换仅影响当前工作区的新任务。\n');
}

function json(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireCount(args, minimum, maximum, usage) {
  if (args.length < minimum || args.length > maximum) throw new Error(`用法：harness ${usage}`);
}

function overrides(options) {
  const settings = {};
  if (options.provider) settings.provider = options.provider;
  if (options.model) settings.model = options.model;
  if (options.auto) settings.approval = 'auto';
  if (options.readonly) settings.approval = 'readonly';
  return settings;
}

async function runTask(harness, prompt, options, io) {
  const settings = harness.getSettings();
  if (settings.configured === false) throw new Error(`请先配置模型服务：${settings.configurationIssues.join('；')}。使用 harness config set 或 TUI 的 F8 设置。`);
  const session = options.session ? harness.getSession(options.session) : await harness.createSession({ title: prompt.slice(0, 60) });
  let readline;
  let interactionQueue = Promise.resolve();
  let streamed = false;
  let finish;
  let finished = false;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  const settle = run => {
    if (finished) return;
    finished = true;
    finish(run);
  };
  const terminalInput = () => {
    if (!readline) {
      readline = createInterface({ input: io.stdin, output: io.stderr });
      readline.on('close', () => { if (!finished) harness.cancelRun(session.id).catch(() => {}); });
    }
    return readline;
  };
  const onEvent = event => {
    if (event.sessionId !== session.id) return;
    if (options.json) {
      io.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.type === 'assistant.delta') {
      io.stdout.write(event.data.text);
      streamed = true;
    } else if (event.type === 'message' && event.data.message.role === 'assistant') {
      if (!streamed && event.data.message.content) io.stdout.write(event.data.message.content);
      if (streamed || event.data.message.content) io.stdout.write('\n');
      streamed = false;
    } else if (event.type === 'tool.started') {
      io.stderr.write(`› ${event.data.name}\n`);
    } else if (event.type === 'tool.failed') {
      io.stderr.write(`工具失败：${event.data.error ?? event.data.name ?? '未知错误'}\n`);
    } else if (event.type === 'run.failed') {
      io.stderr.write(`任务失败：${event.data.run?.error ?? '未知错误'}\n`);
    }
    if (event.type === 'approval.required') {
      interactionQueue = interactionQueue.then(async () => {
        if (finished) return;
        let approved = false;
        if (io.stdin.isTTY && io.stderr.isTTY && !options.json) {
          const answer = await terminalInput().question(`\n工具需要审批：${event.data.tool}\n${JSON.stringify(event.data.args, null, 2)}${event.data.target ? `\n目标：${JSON.stringify(event.data.target)}` : ''}\n允许此次执行？[y/N] `);
          approved = /^(y|yes)$/i.test(answer.trim());
        } else if (!options.json) {
          io.stderr.write(`已拒绝 ${event.data.tool}：当前没有交互终端，可使用 --auto 显式授权。\n`);
        }
        await harness.resolveApproval(event.data.id, approved);
      }).catch(error => {
        if (!finished) io.stderr.write(`审批失败：${error.message}\n`);
      });
    }
    if (event.type === 'question.required') {
      interactionQueue = interactionQueue.then(async () => {
        if (finished) return;
        if (!io.stdin.isTTY || !io.stderr.isTTY || options.json) {
          const error = '任务需要用户回答，当前没有交互终端。已取消任务；请在交互终端或 WebUI / GUI 中继续会话。';
          io.stderr.write(options.json ? `${JSON.stringify({ error, questionId: event.data.id })}\n` : `${error}\n`);
          await harness.cancelRun(session.id);
          return;
        }
        const question = event.data;
        const choices = question.options.map((option, index) => `${index + 1}. ${option}`).join('\n');
        io.stderr.write(`\n青禾 Studio 需要补充信息：${question.question}\n${choices ? `${choices}\n` : ''}`);
        while (!finished && harness.getQuestions().some(pending => pending.id === question.id)) {
          const reply = (await terminalInput().question(choices ? '输入选项编号或自由文本：' : '请输入回答：')).trim();
          const answer = /^[1-8]$/.test(reply) && question.options[Number(reply) - 1] ? question.options[Number(reply) - 1] : reply;
          try { await harness.answerQuestion(question.id, { answer }); break; }
          catch (error) { if (error.statusCode !== 400) throw error; io.stderr.write(`${error.message}\n`); }
        }
      }).catch(error => {
        if (!finished) {
          io.stderr.write(`回答失败：${error.message}\n`);
          harness.cancelRun(session.id).catch(() => {});
        }
      });
    }
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') settle(event.data.run);
  };
  const onInterrupt = () => {
    readline?.close();
    harness.cancelRun(session.id).catch(error => io.stderr.write(`${error.message}\n`));
  };
  harness.on('event', onEvent);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  try {
    if (!options.json) io.stderr.write(`会话 ${session.id} · ${harness.getSettings().provider}\n`);
    const started = await harness.run(session.id, prompt);
    if (terminals.has(started.status)) settle(started);
    const run = await done;
    if (streamed && !options.json) io.stdout.write('\n');
    return run.status === 'failed' ? 1 : run.status === 'cancelled' ? 130 : 0;
  } finally {
    finished = true;
    readline?.close();
    harness.off('event', onEvent);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

async function serve(harness, options, io) {
  const { startServer } = await import('./server.js');
  const server = await startServer({ harness, port: options.port ?? 3210, open: Boolean(options.open) });
  if (options.json) json(io.stdout, { url: server.url });
  else io.stdout.write(`青禾 Studio WebUI: ${server.url}\n按 Ctrl+C 停止服务。\n`);
  await new Promise(resolveStopped => {
    const stop = () => resolveStopped();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.server.once('close', stop);
    server.server.once('error', stop);
  });
  await server.close();
}

async function doctor(harness, workspace, options, io) {
  const settings = harness.getSettings();
  const checks = [{ name: 'Node.js >= 22', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
  try {
    await access(workspace, constants.R_OK | constants.W_OK);
    checks.push({ name: '工作区可读写', ok: true, detail: workspace });
  } catch (error) {
    checks.push({ name: '工作区可读写', ok: false, detail: error.message });
  }
  checks.push({ name: '模型提供方', ok: providers.has(settings.provider), detail: settings.provider });
  const keyReady = Boolean(settings.hasApiKey);
  checks.push({ name: 'API 密钥', ok: keyReady, detail: keyReady ? '已配置（隐藏）' : '未配置；设置 HARNESS_API_KEY 或 config set apiKey' });
  checks.push({ name: '模型名', ok: Boolean(settings.model?.trim()), detail: settings.model || '未配置；使用 config set model 配置' });
  try {
    await access(fileURLToPath(new URL('../dist/index.html', import.meta.url)));
    checks.push({ name: 'WebUI 构建', ok: true, detail: 'dist/index.html' });
  } catch {
    checks.push({ name: 'WebUI 构建', ok: false, detail: '运行 npm run build' });
  }
  for (const extension of harness.extensions ?? []) {
    checks.push({ name: `MCP ${extension.name}`, ok: extension.status !== 'error', detail: extension.status === 'connected' ? `${extension.tools.length} 个工具已连接` : extension.error ?? extension.status });
  }
  const report = { ok: checks.every(check => check.ok), version: VERSION, workspace, configured: settings.configured, checks };
  if (options.json) json(io.stdout, report);
  else {
    for (const check of checks) io.stdout.write(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}\n`);
    io.stdout.write('本地检查未连接模型服务；使用 harness config test 验证实际连接。\n');
  }
  return report.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), io = process) {
  let harness;
  let parsed;
  try {
    parsed = parseArgs(argv);
    const { command, args, options } = parsed;
    if (options.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (options.help || command === 'help') {
      printHelp(io.stdout);
      return 0;
    }
    const commands = new Set(['init', 'run', 'tui', 'web', 'gui', 'sessions', 'config', 'tools', 'doctor']);
    if (!commands.has(command)) throw new Error(`未知命令：${command}；运行 harness --help 查看帮助`);
    if (command === 'init') requireCount(args, 0, 1, 'init [path]');
    if (command === 'run' && !args.join(' ').trim()) throw new Error('用法：harness run <prompt> [--session ID]');
    if (['tui', 'web', 'tools', 'doctor'].includes(command)) requireCount(args, 0, 0, command);
    if (command === 'gui') {
      requireCount(args, 0, 0, 'gui [--workspace PATH]');
      const { launchGui } = await import('../scripts/launch-gui.js');
      return await launchGui({ workspace: options.workspace });
    }
    const workspace = resolve(options.workspace ?? (command === 'init' ? args[0] : undefined) ?? process.cwd());
    if (command === 'init') await mkdir(workspace, { recursive: true });
    harness = await createHarness({ workspace, settings: overrides(options) });
    if (options.browser || options.computer) await harness.configureAutomation({ browser: !!options.browser, desktop: !!options.computer });
    if (command === 'init') {
      if (options.json) json(io.stdout, { workspace, dataDir: join(workspace, '.harness'), settings: harness.getSettings() });
      else io.stdout.write(`已初始化：${workspace}\n状态目录：${join(workspace, '.harness')}\n使用 harness tui --workspace "${workspace}"，按 F8 配置模型服务；或运行 harness web --workspace "${workspace}"。\n`);
    } else if (command === 'run') {
      return await runTask(harness, args.join(' '), options, io);
    } else if (command === 'tui') {
      const { startTui } = await import('./tui.js');
      await startTui({ harness });
    } else if (command === 'web') {
      await serve(harness, options, io);
    } else if (command === 'config') {
      if (args[0] === 'scope') {
        requireCount(args, 1, 2, 'config scope [workspace|global]');
        if (args[1] !== undefined) await harness.setProviderScope(args[1]);
        json(io.stdout, harness.getProviderScopes());
        return 0;
      }
      if (args[0] === 'test') {
        requireCount(args, 1, 1, 'config test');
        const result = await harness.testConnection();
        if (options.json) json(io.stdout, result);
        else io.stdout.write(`连接成功：${result.provider ?? harness.getSettings().provider} / ${result.model ?? harness.getSettings().model}\n`);
        return result.ok === false ? 1 : 0;
      }
      if (args.length) {
        requireCount(args, 3, 3, 'config set <key> <value>');
        if (args[0] !== 'set' || !settingKeys.has(args[1])) throw new Error(`可配置字段：${[...settingKeys].join(', ')}`);
        const value = args[1] === 'modelOrchestration' ? JSON.parse(args[2]) : args[1] === 'autoApproveTools' ? args[2].trim().startsWith('[') ? JSON.parse(args[2]) : args[2].split(',').map(name => name.trim()).filter(Boolean) : numericSettings.has(args[1]) ? Number(args[2]) : args[2];
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${args[1]} 需要数值`);
        await harness.updateSettings({ [args[1]]: value });
      }
      json(io.stdout, harness.getSettings());
    } else if (command === 'sessions') {
      if (!args.length) {
        const sessions = harness.listSessions();
        if (options.json) json(io.stdout, sessions);
        else if (!sessions.length) io.stdout.write('暂无会话。运行 harness run "你的任务" 创建会话。\n');
        else for (const session of sessions) io.stdout.write(`${session.id}  ${session.run?.status ?? 'idle'}  ${session.title}\n`);
      } else {
        requireCount(args, 2, 2, 'sessions [show ID | delete ID]');
        if (args[0] === 'show') json(io.stdout, harness.getSession(args[1]));
        else if (args[0] === 'delete') {
          await harness.deleteSession(args[1]);
          if (options.json) json(io.stdout, { ok: true });
          else io.stdout.write(`会话已删除：${args[1]}\n`);
        } else throw new Error('用法：harness sessions [show ID | delete ID]');
      }
    } else if (command === 'tools') {
      const toolList = harness.getTools();
      if (options.json) json(io.stdout, toolList);
      else for (const tool of toolList) io.stdout.write(`${tool.name}\n  ${tool.description}\n  ${JSON.stringify(tool.parameters)}\n\n`);
    } else if (command === 'doctor') {
      return await doctor(harness, workspace, options, io);
    }
    return 0;
  } catch (error) {
    if (parsed?.options.json || argv.includes('--json')) io.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    else io.stderr.write(`错误：${error.message}\n`);
    return 1;
  } finally {
    await harness?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
