import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const skillContent = '---\nname: project-review\ndescription: Review project changes and test evidence.\n---\n\nRead references/guide.md before reporting.\n';
const config = { command: process.execPath, args: [fileURLToPath(new URL('../fixtures/mcp-server.js', import.meta.url))] };
const region = page => page.getByRole('region', { name: '技能与 MCP 管理' });

test.beforeEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { approval: 'auto', provider: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', model: 'test-model', apiKey: 'test-key' } });
  for (const item of await (await request.get('/api/skills')).json()) await request.delete(`/api/skills/${encodeURIComponent(item.name)}`);
  for (const item of (await (await request.get('/api/mcp')).json()).servers) await request.delete(`/api/mcp/${encodeURIComponent(item.name)}`);
});

test('skills import ZIP, edit, guard unsaved changes, enable and remove', async ({ page, request }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '技能与 MCP', exact: true }).click();
  await expect(page).toHaveURL(/#\/extensions$/);
  await expect(page).toHaveTitle(/青禾 Studio/);
  const view = region(page);
  await expect(view.getByRole('heading', { name: '还没有安装技能' })).toBeVisible();
  const archive = Buffer.from(zipSync({ 'review/SKILL.md': strToU8(skillContent), 'review/references/guide.md': strToU8('真实参考文件已读取') }));
  await view.locator('input[type=file][accept=".md,.zip"]').setInputFiles({ name: 'review.zip', mimeType: 'application/zip', buffer: archive });
  const card = view.getByRole('article', { name: 'project-review' });
  await expect(card).toContainText('已停用');
  await expect(view.getByText('references/guide.md', { exact: true })).toBeHidden();
  await view.getByText('附带文件（2）').click();
  await expect(view.getByText('references/guide.md', { exact: true })).toBeVisible();
  await view.getByLabel('SKILL.md 内容', { exact: true }).fill(skillContent + 'Updated instructions');
  await view.getByRole('tab', { name: /MCP 服务/ }).click();
  await expect(page.getByRole('dialog')).toContainText('有未保存的更改');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(view.getByLabel('SKILL.md 内容', { exact: true })).toHaveValue(/Updated instructions/);
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('已保存');
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card).toContainText('已启用');
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeEnabled();
  await view.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('skills-desktop.png'), fullPage: true });
  await page.reload();
  await expect(card).toContainText('已启用');
  expect((await (await request.get('/api/skills/project-review')).json()).content).toContain('Updated instructions');
  await card.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认移除' }).click();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('MCP imports disabled, connects, edits without echoing secrets, reconnects and uninstalls', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/extensions');
  const view = region(page);
  await view.getByRole('tab', { name: /MCP 服务/ }).click();
  await view.getByRole('button', { name: '粘贴 JSON 配置' }).click();
  await view.getByLabel('mcpServers JSON', { exact: true }).fill(JSON.stringify({ mcpServers: { browser: { ...config, enabled: true, env: { MCP_FIXTURE_SECRET: 'private-browser-secret' } } } }, null, 2));
  await view.getByRole('button', { name: '确认导入', exact: true }).click();
  const card = view.getByRole('article', { name: 'browser', exact: true });
  await expect(card).toContainText('已停用');
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card).toContainText('已连接');
  await card.locator('summary').click();
  await expect(card).toContainText('mcp_browser_echo');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await view.getByText('认证与环境变量', { exact: true }).click();
  await expect(view).toContainText('MCP_FIXTURE_SECRET');
  await expect(view.getByLabel('认证 JSON', { exact: true })).toHaveValue('');
  await expect(view).not.toContainText('private-browser-secret');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('已保存');
  await card.getByRole('button', { name: '重连', exact: true }).click();
  await expect(card).toContainText('已连接');
  await expect(card.getByRole('button', { name: '重连', exact: true })).toBeEnabled();
  await view.getByText('认证与环境变量', { exact: true }).click();
  await view.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('mcp-desktop.png'), fullPage: true });
  await card.getByRole('button', { name: '停用', exact: true }).click();
  await expect(card).toContainText('已停用');
  expect((await (await request.get('/api/tools')).json()).some(tool => tool.name === 'mcp_browser_echo')).toBe(false);
  await card.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认移除' }).click();
  await expect(card).toHaveCount(0);
});

test('skills and MCP execute through the native provider and keep chat alive across navigation', async ({ page, request }) => {
  await request.post('/api/skills', { data: { enabled: true, files: [{ path: 'SKILL.md', data: Buffer.from(skillContent).toString('base64') }, { path: 'references/guide.md', data: Buffer.from('真实参考文件已读取').toString('base64') }] } });
  await request.post('/api/mcp', { data: { name: 'browser', configuration: { ...config, enabled: true } } });
  await page.goto('/');
  await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('[test:extensions]');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('MCP 与 Skill 会话验证成功');
  await expect(page.locator('.message-assistant').last()).toContainText('真实参考文件已读取');
  await page.getByRole('button', { name: '技能与 MCP', exact: true }).click();
  await region(page).getByRole('button', { name: '返回工作台' }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('MCP 与 Skill 会话验证成功');
});

test('extension errors are actionable and narrow layout preserves controls and drafts', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/extensions');
  const view = region(page);
  await view.getByRole('button', { name: '新建技能' }).click();
  await view.getByLabel('技能名称', { exact: true }).fill('bad/name');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('技能名称');
  await expect(view.getByLabel('技能名称', { exact: true })).toHaveValue('bad/name');
  await view.getByRole('tab', { name: /MCP 服务/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃更改' }).click();
  await view.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await view.getByLabel('MCP 名称', { exact: true }).fill('broken');
  await view.getByLabel('启动命令', { exact: true }).fill('nonexistent-qinghe-mcp');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  const card = view.getByRole('article', { name: 'broken', exact: true });
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card).toContainText('连接失败');
  await expect(card.getByRole('button', { name: '重连', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('extensions-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('MCP changes refresh policy tools without discarding unsaved policy edits', async ({ page, request }) => {
  await page.goto('/#/settings');
  const policy = page.getByRole('combobox', { name: '工具审批策略', exact: true });
  await policy.selectOption('ask');
  await request.post('/api/mcp', { data: { name: 'browser', configuration: { ...config, enabled: true } } });
  const exemption = page.getByRole('checkbox', { name: '免审批 mcp_browser_echo', exact: true });
  await expect(exemption).toBeVisible();
  await expect(policy).toHaveValue('ask');
  await exemption.check();
  await request.delete('/api/mcp/browser');
  await expect(exemption).toBeChecked();
  await expect(policy).toHaveValue('ask');
});
