import { test, expect, type Page } from '@playwright/test';
import { createApp } from '../src/server/app.js';
import { ScriptedModel } from '../src/assistant/model.js';
import { FixedClock } from '../src/domain/time.js';
import { mkdirSync } from 'node:fs';
let h: Awaited<ReturnType<typeof createApp>>, url: string;
const BASE = Date.parse('2026-09-18T00:00:00Z');
test.beforeEach(async () => {
  h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    frozenClock: false,
    serviceTrial: true,
    model: new ScriptedModel((input) => {
      const message = JSON.parse(
        input.filter((x) => x.role === 'user').at(-1).content as string,
      ).message;
      if (message.includes('取消'))
        return {
          name: 'quote_operation',
          args: {
            request: {
              action: 'CANCEL',
              targets: [{ ticket_id: 'CANCEL-NSA-A', segment_ids: [], replacements: [] }],
            },
            record_review: false,
          },
        };
      return { name: 'get_service_status', args: {} };
    }),
  });
  url = await h.app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterEach(async () => {
  await h.app.close();
});
async function open(p: Page) {
  await p.goto(url);
  await p.getByRole('textbox', { name: '消息', exact: true }).waitFor();
}
async function demo(p: Page, name: string) {
  await p.locator('.identity').click();
  await p.getByRole('tab', { name: '体验示例', exact: true }).click();
  if (name.startsWith('模拟客服')) {
    await p.getByText('模拟客服角色（本机演示）', { exact: true }).click();
    await p.getByRole('button', { name, exact: true }).click();
    await expect(p.getByRole('heading', { name: '模拟客服工作台' })).toBeVisible();
  } else {
    await p.locator('.account').filter({ hasText: name }).click();
    await expect(p.locator('.identity')).toContainText(name);
  }
}
async function center(p: Page) {
  await p.getByRole('button', { name: '我的服务中心', exact: false }).first().click();
  await expect(p.getByRole('heading', { name: '我的服务中心' })).toBeVisible();
}
async function refresh(p: Page) {
  const response = p.waitForResponse(
    (r) => /\/api\/service(?:\/desk)?$/.test(r.url()) && r.request().method() === 'GET',
  );
  await p.getByRole('button', { name: '刷新进度', exact: true }).click();
  await response;
}
async function chat(p: Page, message: string) {
  await p.getByRole('textbox', { name: '消息', exact: true }).fill(message);
  await p.getByRole('button', { name: '发送', exact: true }).click();
  await expect(p.locator('.user-message').last()).toHaveText(message);
  await expect(p.locator('.progress')).toHaveCount(0);
}

test('Service: register → scoped sample claim → separate desk approval → cancel → unknown refund reconciliation → durable receipt', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.getByRole('button', { name: '我的服务中心', exact: false })).toBeDisabled();
  await page.locator('.identity').click();
  await page.getByRole('tab', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('service_browser');
  await page.getByLabel('密码', { exact: true }).fill('Service-browser-42');
  await page.getByLabel('确认密码', { exact: true }).fill('Service-browser-42');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.locator('.identity')).toContainText('service_browser');
  await center(page);
  await page.getByText('找回样例客票（注册账号）', { exact: true }).click();
  await page.getByLabel('填写演示验证码').fill('DEMO-CANCEL-42');
  await page.getByLabel('同时申请这张票').check();
  await page.getByRole('button', { name: '提交样例核验申请', exact: true }).click();
  const request = page.locator('[data-case-id]');
  await expect(request).toContainText('待接单');
  const context = await browser.newContext();
  const desk = await context.newPage();
  try {
    await open(desk);
    await demo(desk, '模拟客服 1');
    const queue = desk.locator('[data-case-id]');
    await queue.getByRole('button', { name: '接单', exact: true }).click();
    await queue.getByRole('button', { name: '核验演示凭据并授权', exact: true }).click();
    await expect(queue).toContainText('本项已处理');
    await refresh(page);
    await expect(request).toContainText('样例客票授权已建立');
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await chat(page, '取消 CANCEL-NSA-A');
    await expect(page.locator('[data-card="quote"]')).toContainText('$20.00');
    await page.locator('button.confirm').click();
    await expect(page.locator('.success-title')).toContainText('本地办理已登记 · 渠道结果待核对');
    await center(page);
    await expect(page.locator('[data-task-id]')).toHaveCount(2);
    await refresh(desk);
    const order = desk
      .locator('[data-task-id]')
      .filter({ has: desk.getByRole('heading', { name: '订单处理 · CANCEL-NSA-A' }) });
    const refund = desk
      .locator('[data-task-id]')
      .filter({ has: desk.getByRole('heading', { name: '原路退款 · CANCEL-NSA-A' }) });
    await order.getByRole('button', { name: '模拟渠道受理', exact: true }).click();
    await order.getByRole('button', { name: '模拟完成回执', exact: true }).click();
    await refund.getByRole('button', { name: '模拟回执丢失', exact: true }).click();
    await refresh(page);
    await expect(page.locator('[data-task-id]').filter({ hasText: '原路退款' })).toContainText(
      '结果未知 · 待核对',
    );
    await refund.getByRole('button', { name: '查询原请求并核对', exact: true }).click();
    await refund.getByRole('button', { name: '模拟完成回执', exact: true }).click();
    await page.reload();
    await center(page);
    await expect(page.locator('[data-task-id]').filter({ hasText: '原路退款' })).toContainText(
      '模拟完成凭证',
    );
    expect(h.store.get<any>('SELECT count(*) n FROM operations')!.n).toBe(1);
    expect(h.store.get<any>('SELECT count(*) n FROM credits')!.n).toBe(1);
    expect(errors).toEqual([]);
    mkdirSync('evals/service-trial', { recursive: true });
    await page.screenshot({ path: 'evals/service-trial/traveler-progress.png', fullPage: true });
  } finally {
    await context.close();
  }
});

test('Service: applicant and desk exchange information, handoff and guidance without approval; typing survives clock rerender and narrow viewport', async ({
  page,
  browser,
}) => {
  await open(page);
  await demo(page, '林怡 · 旅客');
  await center(page);
  const note = page.getByLabel('需要客服继续处理的事项');
  await note.fill('请原出票渠道核对，金额尚未确定');
  await page.waitForTimeout(1150);
  await expect(note).toHaveValue('请原出票渠道核对，金额尚未确定');
  await page.getByRole('button', { name: '创建咨询 / 转办申请', exact: true }).click();
  await expect(page.locator('[data-case-id]')).toContainText('待接单');
  const context = await browser.newContext(),
    desk = await context.newPage();
  try {
    await open(desk);
    await demo(desk, '模拟客服 1');
    const c = desk.locator('[data-case-id]');
    await c.getByRole('button', { name: '接单', exact: true }).click();
    await c.getByLabel('处理说明 / 非敏感补充信息').fill('请补充非敏感说明');
    await c.getByRole('button', { name: '请求补充信息', exact: true }).click();
    await refresh(page);
    const own = page.locator('[data-case-id]');
    await own
      .getByLabel('处理说明 / 非敏感补充信息')
      .fill('<img src=x onerror=alert(1)>这是补充说明');
    await own.getByRole('button', { name: '提交补充说明', exact: true }).click();
    await refresh(desk);
    await c.getByLabel('处理说明 / 非敏感补充信息').fill('已向模拟出票渠道转办');
    await c.getByRole('button', { name: '转模拟出票渠道', exact: true }).click();
    await c.getByLabel('处理说明 / 非敏感补充信息').fill('模拟渠道回复仍需核对实际材料');
    await c.getByRole('button', { name: '记录模拟渠道回复', exact: true }).click();
    await c.getByRole('button', { name: '答复咨询（不批准退款）', exact: true }).click();
    await refresh(page);
    await expect(own).toContainText('此状态不表示批准退款或免除费用');
    await own.locator('summary').click();
    await expect(own).toContainText('<img src=x onerror=alert(1)>');
    expect(await own.locator('img').count()).toBe(0);
    expect(h.store.get<any>('SELECT count(*) n FROM ledger')!.n).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'evals/service-trial/mobile-case.png', fullPage: true });
  } finally {
    await context.close();
  }
});

test('Service: compare group constraints, clear stale candidates when budget changes, quote without auto-commit and show flight change alert', async ({
  page,
  browser,
}) => {
  await open(page);
  await demo(page, '许悦 · 已授权代理');
  await center(page);
  await page.getByText('按预算和到达时间比较改签方案', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'NSA-A · 林怡', exact: true }).check();
  await page.getByRole('checkbox', { name: 'NSA-B · 陈平', exact: true }).check();
  await page.getByLabel('最高总补款').fill('220');
  await page.getByRole('button', { name: '比较可用方案', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '选择此方案并重新报价', exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel('最高总补款').fill('0');
  await expect(page.getByRole('button', { name: '选择此方案并重新报价', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '比较可用方案', exact: true }).click();
  await expect(page.locator('.service-panel')).toContainText('没有满足全部条件');
  await page.getByLabel('最高总补款').fill('220');
  await page.getByRole('button', { name: '比较可用方案', exact: true }).click();
  await page.getByRole('button', { name: '选择此方案并重新报价', exact: true }).first().click();
  await expect(page.locator('[data-card="quote"]')).toBeVisible();
  expect(h.store.get<any>('SELECT count(*) n FROM operations')!.n).toBe(0);
  const context = await browser.newContext(),
    desk = await context.newPage();
  try {
    await open(desk);
    await demo(desk, '模拟客服 1');
    await desk.getByText('模拟新的航班变动', { exact: true }).click();
    await desk
      .getByRole('button', { name: '模拟 NSA-A-S1 延后180分钟', exact: true })
      .first()
      .click();
    await page.locator('button.confirm').click();
    await expect(page.locator('[data-card="submission"]').last()).toContainText('未完成');
    await center(page);
    await expect(page.locator('.service-panel')).toContainText('行程动态');
    expect(h.store.get<any>('SELECT count(*) n FROM operations')!.n).toBe(0);
    await desk.screenshot({ path: 'evals/service-trial/service-desk.png', fullPage: true });
  } finally {
    await context.close();
  }
});
