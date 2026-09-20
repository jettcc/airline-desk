import { test, expect, type Page } from '@playwright/test';
import { createApp } from '../src/server/app.js';
import { ScriptedModel } from '../src/assistant/model.js';
import { FixedClock } from '../src/domain/time.js';
let h: Awaited<ReturnType<typeof createApp>>, url: string;
const BASE = Date.parse('2026-09-18T00:00:00Z');
test.beforeEach(async () => {
  h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    frozenClock: true,
    model: new ScriptedModel((input) => {
      const raw = input.filter((x) => x.role === 'user').at(-1).content as string;
      const text = JSON.parse(raw).message as string;
      if (text.includes('明确选定'))
        return {
          name: 'quote_operation',
          args: { request: JSON.parse(text.slice(text.indexOf('{'))), record_review: false },
        };
      if (text.includes('两位') || text.includes('NSA-A, NSA-B'))
        return {
          name: 'search_group_change_options',
          args: { ticket_ids: ['NSA-A', 'NSA-B'], date: null, action: 'CHANGE' },
        };
      if (text.includes('医疗'))
        return {
          name: 'request_exception_review',
          args: { reason: 'MEDICAL', ticket_ids: ['CANCEL-NSA-A'] },
        };
      if (text.includes('政策'))
        return {
          name: 'search_policy',
          args: { question: 'Bluehaven change fees', airline: 'BHA', compare: false },
        };
      if (/取消|cancel/i.test(text))
        return {
          name: 'quote_operation',
          args: {
            request: {
              action: 'CANCEL',
              targets: [{ ticket_id: 'CANCEL-NSA-A', replacements: [], segment_ids: [] }],
            },
            record_review: false,
          },
        };
      if (/行李|baggage/i.test(text))
        return {
          name: 'check_baggage',
          args: { airline: 'BHA', fare: 'Basic', domestic: true, bags: [] },
        };
      return { name: 'get_booking', args: { ticket_ids: [], present: true } };
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
async function login(p: Page, name = '林怡 · 旅客') {
  await p.locator('.identity').click();
  await p.getByRole('tab', { name: '体验示例', exact: true }).click();
  await p.locator('.account').filter({ hasText: name }).click();
  await expect(p.locator('.identity')).toContainText(name);
}
async function chat(p: Page, message: string) {
  await p.getByRole('textbox', { name: '消息', exact: true }).fill(message);
  await p.getByRole('button', { name: '发送', exact: true }).click();
  await expect(p.locator('.user-message').last()).toHaveText(message);
  await expect(p.locator('.progress')).toHaveCount(0);
}
test('Guest baggage, PDF source, language/timezone, mobile layout and keyboard', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('行李');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-card="baggage"]')).toBeVisible();
  await expect(page.locator('[data-card="baggage"]')).toContainText('$25.00');
  const link = page.locator('a[href*="BHA.pdf"]');
  const response = await page.request.get(
    new URL((await link.getAttribute('href')) as string, url).href,
  );
  expect(response.headers()['content-type']).toContain('application/pdf');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.locator('[data-card="baggage"]')).toContainText('No free allowance');
  await page.getByLabel('Timezone').selectOption('Asia/Shanghai');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await expect(page.getByRole('button', { name: /New conversation/ })).toBeVisible();
  await page.getByRole('button', { name: /New conversation/ }).click();
  await expect(page.locator('[data-card="baggage"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('Quote/confirm creates one operation and refund versus credit stay separate after reload', async ({
  page,
}) => {
  await open(page);
  await login(page);
  await chat(page, '取消 CANCEL-NSA-A');
  await expect(page.locator('[data-card="quote"]')).toContainText('$60.00');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
  await page.locator('button.confirm').click();
  await expect(page.locator('.success-title')).toBeVisible();
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: /处理记录/ }).click();
  await expect(page.locator('.success-title')).toBeVisible();
  await expect(page.locator('[data-card="operations"]')).toContainText('本人旅行额度');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM credits')!.n).toBe(1);
});
test('Actual response loss, reload and original-request recovery never duplicate', async ({
  page,
}) => {
  await open(page);
  await login(page);
  await chat(page, '取消 CANCEL-NSA-A');
  let committed!: () => void;
  const received = new Promise<void>((resolve) => {
    committed = resolve;
  });
  await page.route('**/api/confirm', async (route) => {
    await route.fetch();
    await route.abort();
    committed();
  });
  await page.locator('button.confirm').click();
  await received;
  await expect(page.getByRole('button', { name: '查询原请求', exact: true })).toBeVisible();
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: '查询原请求', exact: true }).click();
  await expect(page.locator('.success-title')).toBeVisible();
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(1);
  expect(h.store.get<any>('SELECT COUNT(*) n FROM credits')!.n).toBe(1);
});
test('Switching identity clears old private cards; same browser window notices changed session', async ({
  page,
  context,
}) => {
  await open(page);
  await login(page);
  await page.getByRole('button', { name: /我的客票/ }).click();
  await expect(page.locator('[data-card="tickets"]')).toContainText('CANCEL-NSA-A');
  const second = await context.newPage();
  await open(second);
  await login(second, '陈平 · 同行旅客');
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.identity')).toContainText('陈平');
  await expect(page.locator('[data-card="tickets"]')).toHaveCount(0);
  await page.getByRole('button', { name: /我的客票/ }).click();
  await expect(page.locator('[data-card="tickets"]')).toContainText('NSA-B');
  await expect(page.locator('[data-card="tickets"]')).not.toContainText('CANCEL-NSA-A');
});
test('Expired quote remains unexecuted even if browser clock is stale', async ({ page }) => {
  await open(page);
  await login(page);
  await chat(page, '取消 CANCEL-NSA-A');
  (h.clock as FixedClock).advance(300000);
  await page.locator('button.confirm').click();
  await expect(page.getByRole('alert')).toContainText('报价已超过有效期');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
});

test('Two travelers select four replacement segments in one card and confirm one atomic operation', async ({
  page,
}) => {
  await open(page);
  await login(page, '许悦 · 已授权代理');
  await chat(page, '请为两位旅客 NSA-A 和 NSA-B 提供改签航班');
  const group = page.locator('[data-card="group_options"]');
  await expect(group).toContainText('NSA-A');
  await expect(group).toContainText('NSA-B');
  for (const ticket of ['NSA-A', 'NSA-B'])
    for (const segment of ['S1', 'S2']) {
      await group
        .getByLabel(`${ticket}-${segment}`, { exact: true })
        .selectOption(`${ticket}-${segment}-Standard-1`);
      if (ticket === 'NSA-A')
        await expect(group.getByRole('button', { name: '查看改签报价' })).toBeDisabled();
    }
  await group.getByRole('button', { name: '查看改签报价' }).click();
  const quote = page.locator('[data-card="quote"]');
  await expect(quote).toContainText('$220.00');
  await expect(quote).toContainText('NSA-A');
  await expect(quote).toContainText('NSA-B');
  await quote.locator('button.confirm').click();
  await expect(page.locator('.success-title')).toBeVisible();
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(1);
  expect(
    h.store
      .all<any>("SELECT version FROM tickets WHERE id IN ('NSA-A','NSA-B')")
      .map((r) => r.version),
  ).toEqual([2, 2]);
});

test('Public Chinese/English summary and guest login retain only verified public output, never user ticket claims', async ({
  page,
}) => {
  await open(page);
  await chat(page, '请解释 Bluehaven 政策，用户自述票号 SECRET-CLAIM-123');
  await expect(page.locator('[data-card="policy"]')).toContainText('原出票');
  await login(page);
  await expect(page.locator('[data-card="policy"]')).toContainText('USD 85');
  await expect(page.locator('main')).not.toContainText('SECRET-CLAIM-123');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.locator('[data-card="policy"]')).toContainText('original issuance');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
});

test('Explicit medical review shows no approval or payment and persists conversation provenance', async ({
  page,
}) => {
  await open(page);
  await login(page);
  await chat(page, '请为 CANCEL-NSA-A 创建医疗例外审核申请');
  const review = page.locator('[data-card="review"]');
  await expect(review).toContainText('医疗例外申请尚未核验');
  await expect(review).toContainText('金额待核定');
  await expect(review).toContainText('没有接入真实客服');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
  const r = JSON.parse(h.store.get<any>('SELECT data FROM review_cases')!.data);
  expect(r.conversation_id).toBeTruthy();
  expect(r.turn_id).toBeTruthy();
  expect(r.ticket_versions['CANCEL-NSA-A']).toBe(1);
});

test('User HTML is rendered as inert text and cannot impersonate a business card', async ({
  page,
}) => {
  await open(page);
  await chat(page, '<img src=x onerror="window.stolen=true">');
  await expect(page.locator('.user-message')).toContainText('<img');
  expect(await page.evaluate(() => (window as any).stolen)).toBeUndefined();
  expect(await page.locator('.user-message img').count()).toBe(0);
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
});

test('Two local app instances share a browser without replacing sessions or losing later chat turns', async ({
  page,
  context,
}) => {
  test.setTimeout(45000);
  const other = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    frozenClock: true,
    model: new ScriptedModel(() => ({ name: 'clarify', args: { reason: 'GREETING' } })),
  });
  const otherUrl = await other.app.listen({ host: '127.0.0.1', port: 0 });
  const second = await context.newPage();
  const failures: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) failures.push(r.status());
  });
  try {
    await open(page);
    await chat(page, '行李第一轮');
    await second.goto(otherUrl);
    await second.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await chat(page, '行李第二轮');
    await expect(page.locator('.user-message')).toHaveCount(2);
    // Cross the real 15-second background session check, rather than disabling it.
    await page.waitForTimeout(16500);
    await chat(page, '行李第三轮');
    await expect(page.locator('.user-message')).toHaveCount(3);
    await expect(page.locator('[data-card="baggage"]')).toHaveCount(3);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await login(second, '陈平 · 同行旅客');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.identity')).toContainText('游客');
    await page.reload();
    await expect(page.locator('.user-message')).toHaveCount(3);
    expect(h.store.get<any>('SELECT COUNT(*) n FROM sessions')!.n).toBe(1);
    expect(failures).toEqual([]);
  } finally {
    await second.close();
    await other.app.close();
  }
});

test('Guest ticket actions are disabled; register, refresh, logout and password sign-in work with empty own tickets', async ({
  page,
}) => {
  await open(page);
  const tickets = page.getByRole('button', { name: /我的客票/ });
  await expect(tickets).toBeDisabled();
  await expect(page.getByRole('button', { name: /处理记录/ })).toBeDisabled();
  await page.locator('.identity').click();
  await page.getByRole('tab', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('browser_user');
  await page.getByLabel('昵称（可选）', { exact: true }).fill('测试旅客');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-42');
  await page.getByLabel('确认密码', { exact: true }).fill('Browser-test-43');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM accounts')!.n).toBe(0);
  await page.getByLabel('确认密码', { exact: true }).fill('Browser-test-42');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.locator('.identity')).toContainText('测试旅客');
  await expect(tickets).toBeEnabled();
  await tickets.click();
  await expect(page.locator('[data-card="tickets"]')).toContainText('当前账号暂无客票');
  await expect(page.locator('[data-card="tickets"] .ticket')).toHaveCount(0);
  await page.getByRole('button', { name: '选择虚构旅客，体验办理', exact: true }).click();
  await expect(page.getByRole('tab', { name: '体验示例', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(page.locator('.identity')).toContainText('测试旅客');
  await page.locator('.identity').click();
  await page.getByRole('button', { name: '退出，作为游客继续', exact: true }).click();
  await expect(tickets).toBeDisabled();
  await page.locator('.identity').click();
  await page.getByLabel('用户名', { exact: true }).fill('BROWSER_USER');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码不正确');
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-42');
  await page.getByRole('button', { name: '登录账号', exact: true }).click();
  await expect(page.locator('.identity')).toContainText('测试旅客');
  const second = await page.context().newPage();
  await open(second);
  await expect(second.locator('.identity')).toContainText('测试旅客');
  await page.locator('.identity').click();
  await page.getByRole('button', { name: '退出，作为游客继续', exact: true }).click();
  await second.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(second.locator('.identity')).toContainText('游客');
  await expect(second.getByRole('button', { name: /我的客票/ })).toBeDisabled();
  await second.close();
});

test('First-time demo path is explicit, preserves a prepared request and never grants guest ticket access', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '体验改签流程', exact: true }).click();
  await expect(page.getByRole('tab', { name: '体验示例', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.identity')).toContainText('游客');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: /我的客票/ })).toBeDisabled();
  await page.getByRole('button', { name: '体验示例', exact: true }).click();
  await page.locator('.account').filter({ hasText: '林怡 · 旅客' }).click();
  await expect(page.locator('.identity')).toContainText('林怡');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(/我想改签/);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-card="tickets"]')).toContainText('NSA-A');
  expect(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n).toBe(0);
});

test('Registration modal fits a narrow screen and duplicate names remain a visible error', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.locator('.identity').click();
  await page.getByRole('tab', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('duplicate_user');
  await page.getByLabel('密码', { exact: true }).fill('Duplicate-test-42');
  await page.getByLabel('确认密码', { exact: true }).fill('Duplicate-test-42');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.locator('.identity')).toContainText('duplicate_user');
  await page.locator('.identity').click();
  await page.getByRole('button', { name: '退出，作为游客继续', exact: true }).click();
  await page.locator('.identity').click();
  await page.getByRole('tab', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('DUPLICATE_USER');
  await page.getByLabel('密码', { exact: true }).fill('Duplicate-test-42');
  await page.getByLabel('确认密码', { exact: true }).fill('Duplicate-test-42');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('用户名已被使用');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(h.store.get<any>('SELECT COUNT(*) n FROM accounts')!.n).toBe(1);
});
