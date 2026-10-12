import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { addProvider, addModel, modelRow, testModel } from './provider-helpers.js';

const evidence = path.join(os.tmpdir(), 'qinghe-qa-1.14');
const defaults = { compressionModel: null, decision: { enabled: false, model: null, minConfidence: 0.65 }, routing: { enabled: false, candidates: [] } };

test.beforeEach(async ({ request }) => {
  await mkdir(evidence, { recursive: true });
  await request.post('/api/automation/stop', { data: {} });
  for (const session of await (await request.get('/api/sessions')).json()) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await request.delete(`/api/sessions/${session.id}`);
  }
  await request.post('/api/provider-scopes', { data: { scope: 'workspace' } });
  await request.patch('/api/settings', { data: { modelOrchestration: defaults, approval: 'ask' } });
});

test.afterEach(async ({ request }) => {
  for (const session of await (await request.get('/api/sessions')).json()) await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
  await request.patch('/api/settings', { data: { modelOrchestration: defaults } });
});

test('System One can be configured and tested through the provider UI without becoming a chat model', async ({ page }) => {
  await page.goto('/#/providers');
  await expect(page.getByRole('heading', { name: '供应商与模型', exact: true })).toBeVisible();
  await addProvider(page, { name: '原生 Jev 界面验证', protocol: 'systemone', baseUrl: 'http://127.0.0.1:3418/v1' });
  await expect(page.getByText('POST /systemone', { exact: true })).toBeVisible();
  await addModel(page, { id: 'jev-latest', name: 'Jev' });
  await expect(modelRow(page, 'jev-latest').getByRole('button', { name: '设为默认', exact: true })).toBeDisabled();
  await testModel(page, 'jev-latest');
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`configure independent models, run dynamic routing and reload at ${viewport.width}px`, async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await page.setViewportSize(viewport);
    const name = `路由执行 ${viewport.width}`;
    const create = await request.post('/api/providers', { data: { name, protocol: 'responses', baseUrl: 'http://127.0.0.1:3418/v1', apiKey: 'test-key', models: [{ id: 'route-reader', name: '分析' }, { id: 'route-coder', name: '编程' }, { id: 'route-writer', name: '总结' }, { id: 'cheap', name: '压缩' }] } });
    expect(create.ok()).toBe(true);
    const provider = (await create.json()).providers.find(item => item.name === name);
    const decisionName = `Jev 决策 ${viewport.width}`;
    const decisionResult = await request.post('/api/providers?scope=global', { data: { name: decisionName, protocol: 'systemone', baseUrl: 'http://127.0.0.1:3418/v1', apiKey: 'test-key', models: [{ id: 'jev-latest', name: 'Jev' }] } });
    expect(decisionResult.ok()).toBe(true);
    const decision = (await decisionResult.json()).providers.find(item => item.name === decisionName);
    await request.post('/api/providers/active', { data: { providerId: provider.id, modelId: 'route-reader' } });
    await page.goto('/#/settings');
    await expect(page).toHaveTitle('青禾 Studio');
    const policy = page.getByRole('main', { name: '运行策略', exact: true });
    await expect(policy.getByRole('heading', { name: '模型协作', exact: true })).toBeVisible();
    await policy.getByLabel('上下文压缩模型', { exact: true }).selectOption(JSON.stringify(['workspace', provider.id, 'cheap']));
    await policy.getByLabel('决策模型', { exact: true }).selectOption(JSON.stringify(['global', decision.id, 'jev-latest']));
    await policy.getByLabel('启用决策辅助', { exact: true }).check();
    await policy.getByLabel('启用智能模型路由', { exact: true }).check();
    for (const model of provider.models.slice(0, 3)) {
      const label = `工作区 · ${name} / ${model.name}`;
      await policy.getByLabel(`路由候选 ${label}`, { exact: true }).check();
      await policy.getByLabel(`模型专长 ${label}`, { exact: true }).fill(`${model.name}任务优先使用此模型`);
    }
    await policy.getByRole('button', { name: '保存运行策略', exact: true }).click();
    await expect(policy).toContainText('运行策略已保存');
    const saved = (await (await request.get('/api/settings')).json()).modelOrchestration;
    expect(saved.compressionModel.modelId).toBe('cheap');
    expect(saved.decision.model.scope).toBe('global');
    expect(saved.routing.candidates).toHaveLength(3);
    await page.reload();
    await expect(policy.getByLabel('启用智能模型路由', { exact: true })).toBeChecked();
    await expect(policy.getByLabel('决策模型', { exact: true })).toHaveValue(JSON.stringify(['global', decision.id, 'jev-latest']));
    await policy.getByRole('heading', { name: '模型协作', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(evidence, `model-policy-${viewport.width}.png`) });
    await policy.getByRole('region', { name: '模型协作', exact: true }).screenshot({ path: path.join(evidence, `model-policy-full-${viewport.width}.png`) });
    await policy.getByRole('button', { name: '返回工作台', exact: true }).click();
    await page.getByRole('textbox', { name: '发送给 青禾 Studio 的任务' }).fill('检查工作区并汇报结果');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByText('智能路由验证完成：已查看工作区，由总结模型汇报结果。', { exact: true })).toBeVisible();
    let session;
    await expect.poll(async () => {
      const sessions = await (await request.get('/api/sessions')).json();
      session = sessions.find(item => item.messages.at(-1)?.content.includes('智能路由验证完成'));
      return session?.run.status;
    }).toBe('completed');
    expect(session.run.status).toBe('completed');
    expect(session.run.model).toBe('route-writer');
    expect(session.events.filter(event => event.type === 'decision.completed').map(event => event.data.phase)).toEqual(['start', 'progress', 'summary']);
    expect(session.events.filter(event => event.type === 'model.routed')).toHaveLength(2);
    expect(session.run.modelUsage.find(item => item.purpose === 'decision').requests).toBe(3);
    await page.screenshot({ path: path.join(evidence, `routing-result-${viewport.width}.png`) });
    await expect(page.locator('vite-error-overlay, nextjs-portal')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
