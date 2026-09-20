import React, { useEffect, useRef, useState } from 'react';
import { moneyText } from '../src/domain/money';
import { errorLabel } from './i18n';
const states: Record<string, string> = {
  QUEUED: '等待渠道受理',
  PROCESSING: '渠道处理中',
  COMPLETED: '模拟渠道已确认',
  FAILED: '渠道失败 · 需接手',
  UNKNOWN: '结果未知 · 待核对',
  NEW: '待接单',
  IN_REVIEW: '客服核对中',
  NEEDS_INFO: '等待补充信息',
  WAITING_CHANNEL: '等待出票渠道回复',
  RESOLVED: '本项已处理',
  REJECTED: '申请未通过',
  ACCESS_REVOKED: '授权已撤销',
};
const events: Record<string, string> = {
  ...states,
  CLAIM: '客服接单',
  REQUEST_INFO: '请求补充信息',
  REPLY: '旅客补充信息',
  HANDOFF: '转交模拟出票渠道',
  CHANNEL_REPLY: '模拟渠道回复',
  RESOLVE: '咨询已答复（非退款批准）',
  REJECT: '申请未通过',
  APPROVE_ACCESS: '样例授权已建立',
  REVOKE_ACCESS: '样例授权已撤销',
  ACCEPT: '模拟渠道受理',
  CONFIRM: '收到模拟完成回执',
  FAIL: '模拟渠道失败',
  LOSE_REPLY: '模拟回执丢失',
  RECONCILE: '查询原请求核对结果',
};
export const serviceState = (state: string) => states[state] ?? state;
export function ServiceTimeline({
  entries,
  date,
}: {
  entries: any[];
  date: (ms: number) => string;
}) {
  return (
    <details>
      <summary>查看处理时间线（{entries.length}）</summary>
      <ol className="service-timeline">
        {entries.map((e) => (
          <li key={e.version}>
            <strong>{events[e.code] ?? e.code}</strong> · {e.actor} · {date(e.at_ms)}
            {e.note && <p>{e.note}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
export function ServiceOverview({ data, date }: { data: any; date: (ms: number) => string }) {
  return (
    <div className="service-overview">
      <p className="notice">
        本地模拟服务进度。渠道回执、到账和客服身份均为演示，未连接真实航司或银行。
      </p>
      {data.tasks?.map((t: any) => (
        <article className="service-item" key={t.id} data-task-id={t.id}>
          <h4>
            {t.kind === 'REFUND' ? '原路退款' : '订单处理'} · {t.ticket_id}
          </h4>
          <strong>{serviceState(t.state)}</strong>
          {t.amount && <p>应退 ${moneyText(t.amount)}（模拟）</p>}
          <p>{t.next_step}</p>
          {t.receipt && <p className="reference">模拟完成凭证：{t.receipt.reference}</p>}
          <ServiceTimeline entries={t.timeline} date={date} />
        </article>
      ))}
      {data.cases?.map((c: any) => (
        <article className="service-item" key={c.id}>
          <h4>服务申请 · {c.id}</h4>
          <p>
            {c.restricted ? '权限已变化，内容不可查看。' : `${serviceState(c.state)} · ${c.owner}`}
          </p>
          {!c.restricted && (
            <>
              <p>{c.next_step}</p>
              <ServiceTimeline entries={c.timeline} date={date} />
            </>
          )}
        </article>
      ))}
      {data.alerts?.map((a: any) => (
        <article className="notice" key={a.id}>
          <strong>{a.ticket_id} · 行程动态</strong>
          <p>{a.message}</p>
          <p>{date(a.at_ms)}</p>
        </article>
      ))}
    </div>
  );
}
export function ServicePanel({
  api,
  operator,
  samples,
  date,
  onQuote,
  onTickets,
  onBack,
}: {
  api: (path: string, body?: any) => Promise<any>;
  operator: boolean;
  samples: any[];
  date: (ms: number) => string;
  onQuote: (request: any) => Promise<void>;
  onTickets: () => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<any>(null),
    [tickets, setTickets] = useState<any[]>([]),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [sample, setSample] = useState(samples[0]?.ticket_id ?? ''),
    [code, setCode] = useState(''),
    [manage, setManage] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [deadline, setDeadline] = useState(''),
    [budget, setBudget] = useState(''),
    [comparison, setComparison] = useState<any>(null),
    [accessKey, setAccessKey] = useState(crypto.randomUUID()),
    [claimText, setClaimText] = useState(''),
    [helpKey, setHelpKey] = useState(crypto.randomUUID());
  const alive = useRef(true);
  async function refresh() {
    const [next, own] = await Promise.all([
      api(operator ? '/service/desk' : '/service'),
      operator ? Promise.resolve([]) : api('/tickets'),
    ]);
    if (alive.current) {
      setData(next);
      setTickets(own);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => setError(e.message));
    return () => {
      alive.current = false;
    };
  }, []);
  async function act(fn: () => Promise<any>) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'NETWORK');
    } finally {
      if (alive.current) setPending(false);
    }
  }
  function caseAction(c: any, action: string) {
    return act(() =>
      api('/service/case-action', {
        case_id: c.id,
        version: c.version,
        action,
        note: notes[c.id] ?? '',
        request_key: `case:${c.id}:${c.version}:${action}`,
      }),
    );
  }
  function taskAction(t: any, action: string) {
    return act(() =>
      api('/service/task-action', {
        task_id: t.id,
        version: t.version,
        action,
        request_key: `task:${t.id}:${t.version}:${action}`,
      }),
    );
  }
  return (
    <section className="service-panel" aria-label={operator ? '模拟客服工作台' : '我的服务中心'}>
      <div className="service-heading">
        <h2>{operator ? '模拟客服工作台' : '我的服务中心'}</h2>
        <button onClick={onBack}>返回对话</button>
      </div>
      <p className="notice">
        试用范围：三家虚构航司的自营样例订单。所有核验、渠道和客服处理均为本地模拟；外部出票订单需要原出票渠道继续处理。此处不收集证件、病历或支付资料。
      </p>
      <div className="service-actions">
        <button disabled={pending} onClick={() => void act(async () => {})}>
          刷新进度
        </button>
        {!operator && <button onClick={onTickets}>查看客票 / 重新选择方案</button>}
      </div>
      {error && (
        <p className="auth-error" role="alert">
          {errorLabel(error, 'zh')} 请刷新查看当前状态；网络异常时不要另建一笔办理。
        </p>
      )}
      {!data && !error && <p>正在读取已保存的服务记录…</p>}
      {data?.alerts?.map((a: any) => (
        <article className="notice" key={a.id}>
          <b>{a.ticket_id} · 行程动态</b>
          <p>{a.message}</p>
          <p>新起飞：{date(a.departure_at_ms)}</p>
        </article>
      ))}
      {!operator && (
        <details className="service-item">
          <summary>找回样例客票（注册账号）</summary>
          <p>
            使用公开的虚构验证码演示核验流程，不代表真实身份认证。客服批准前没有客票权限，批准也只覆盖选中的一张票；授权最长8小时。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api('/service/access', {
                  ticket_id: sample,
                  code,
                  actions: manage
                    ? [
                        'READ',
                        'CHANGE',
                        'CANCEL',
                        'TAX_REFUND',
                        'DISRUPTION_CHANGE',
                        'DISRUPTION_REFUND',
                      ]
                    : ['READ'],
                  request_key: accessKey,
                });
                setCode('');
                setAccessKey(crypto.randomUUID());
              });
            }}
          >
            <label>
              样例客票
              <select
                value={sample}
                onChange={(e) => {
                  setSample(e.target.value);
                  setAccessKey(crypto.randomUUID());
                }}
              >
                {samples.map((s) => (
                  <option key={s.ticket_id} value={s.ticket_id}>
                    {s.ticket_id} · {s.description}
                  </option>
                ))}
              </select>
            </label>
            <p>演示验证码：{samples.find((s) => s.ticket_id === sample)?.code}</p>
            <label>
              填写演示验证码
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setAccessKey(crypto.randomUUID());
                }}
                required
                maxLength={100}
              />
            </label>
            <label className="service-check">
              <input
                type="checkbox"
                checked={manage}
                onChange={(e) => {
                  setManage(e.target.checked);
                  setAccessKey(crypto.randomUUID());
                }}
              />
              同时申请这张票的改签、取消和适用退税/航变办理权限（每次仍需确认）
            </label>
            <button type="submit" disabled={pending}>
              提交样例核验申请
            </button>
          </form>
        </details>
      )}
      <h3>办理与退款进度</h3>
      {data?.tasks?.length === 0 && (
        <p>暂无新办理任务。历史作业记录仍在“处理记录”中，不补造渠道完成回执。</p>
      )}
      {data?.tasks?.map((t: any) => (
        <article className="service-item" key={t.id} data-task-id={t.id}>
          <h4>
            {t.kind === 'REFUND' ? '原路退款' : '订单处理'} · {t.ticket_id}
          </h4>
          <strong>{serviceState(t.state)}</strong>
          {t.amount && <p>应退 ${moneyText(t.amount)}（模拟，状态未完成时不表示到账）</p>}
          <p>
            {t.owner} · {t.next_step}
          </p>
          {t.receipt && <p className="reference">模拟完成凭证：{t.receipt.reference}</p>}
          {operator && t.state !== 'COMPLETED' && (
            <div className="service-actions">
              {t.state === 'QUEUED' && (
                <button disabled={pending} onClick={() => void taskAction(t, 'ACCEPT')}>
                  模拟渠道受理
                </button>
              )}
              {t.state === 'PROCESSING' && (
                <button disabled={pending} onClick={() => void taskAction(t, 'CONFIRM')}>
                  模拟完成回执
                </button>
              )}
              {['QUEUED', 'PROCESSING'].includes(t.state) && (
                <>
                  <button disabled={pending} onClick={() => void taskAction(t, 'LOSE_REPLY')}>
                    模拟回执丢失
                  </button>
                  <button disabled={pending} onClick={() => void taskAction(t, 'FAIL')}>
                    模拟渠道失败
                  </button>
                </>
              )}
              {['UNKNOWN', 'FAILED'].includes(t.state) && (
                <button disabled={pending} onClick={() => void taskAction(t, 'RECONCILE')}>
                  查询原请求并核对
                </button>
              )}
            </div>
          )}
          <ServiceTimeline entries={t.timeline} date={date} />
        </article>
      ))}
      <h3>人工服务申请</h3>
      {!operator && (
        <form
          className="service-item"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api('/service/help', { request_key: helpKey, note: claimText });
              setClaimText('');
              setHelpKey(crypto.randomUUID());
            });
          }}
        >
          <label>
            需要客服继续处理的事项（不要填写敏感原件资料）
            <textarea
              value={claimText}
              maxLength={500}
              required
              onChange={(e) => {
                setClaimText(e.target.value);
                setHelpKey(crypto.randomUUID());
              }}
            />
          </label>
          <button disabled={pending}>创建咨询 / 转办申请</button>
        </form>
      )}
      {data?.cases?.length === 0 && <p>暂无服务申请。</p>}
      {data?.cases?.map((c: any) => (
        <article className="service-item" key={c.id} data-case-id={c.id}>
          <h4>{c.type === 'SAMPLE_ACCESS' ? '样例客票核验' : '咨询与例外审核'}</h4>
          <p className="reference">{c.id}</p>
          {c.restricted ? (
            <p>权限已变化，业务详情不可查看。</p>
          ) : (
            <>
              <strong>
                {serviceState(c.state)} · {c.owner}
              </strong>
              <p>{c.next_step}</p>
              <p>{c.summary}</p>
              {c.access && (
                <p>
                  {c.access.ticket_id} · 申请范围 {c.access.actions.join(' / ')} · 到期{' '}
                  {date(c.access.expires_at_ms)}
                </p>
              )}
              {c.amount?.status === 'UNKNOWN' && c.type !== 'SAMPLE_ACCESS' && (
                <p>金额待核定；本申请不会自动退款或免除费用。</p>
              )}
              {(operator || c.state === 'NEEDS_INFO') && (
                <label>
                  处理说明 / 非敏感补充信息
                  <textarea
                    maxLength={500}
                    value={notes[c.id] ?? ''}
                    onChange={(e) => setNotes((v) => ({ ...v, [c.id]: e.target.value }))}
                  />
                </label>
              )}
              <div className="service-actions">
                {operator && c.state === 'NEW' && (
                  <button disabled={pending} onClick={() => void caseAction(c, 'CLAIM')}>
                    接单
                  </button>
                )}
                {operator && c.state === 'IN_REVIEW' && (
                  <>
                    <button disabled={pending} onClick={() => void caseAction(c, 'REQUEST_INFO')}>
                      请求补充信息
                    </button>
                    <button disabled={pending} onClick={() => void caseAction(c, 'HANDOFF')}>
                      转模拟出票渠道
                    </button>
                    <button disabled={pending} onClick={() => void caseAction(c, 'REJECT')}>
                      说明理由并拒绝
                    </button>
                    <button
                      disabled={pending}
                      onClick={() =>
                        void caseAction(
                          c,
                          c.type === 'SAMPLE_ACCESS' ? 'APPROVE_ACCESS' : 'RESOLVE',
                        )
                      }
                    >
                      {c.type === 'SAMPLE_ACCESS' ? '核验演示凭据并授权' : '答复咨询（不批准退款）'}
                    </button>
                  </>
                )}
                {operator && c.state === 'WAITING_CHANNEL' && (
                  <button disabled={pending} onClick={() => void caseAction(c, 'CHANNEL_REPLY')}>
                    记录模拟渠道回复
                  </button>
                )}
                {!operator && c.state === 'NEEDS_INFO' && (
                  <button disabled={pending} onClick={() => void caseAction(c, 'REPLY')}>
                    提交补充说明
                  </button>
                )}
                {!operator && c.type === 'SAMPLE_ACCESS' && c.state === 'RESOLVED' && (
                  <button disabled={pending} onClick={() => void caseAction(c, 'REVOKE_ACCESS')}>
                    撤销这张样票的授权
                  </button>
                )}
              </div>
              <ServiceTimeline entries={c.timeline} date={date} />
            </>
          )}
        </article>
      ))}
      {!operator && (
        <details className="service-item">
          <summary>按预算和到达时间比较改签方案</summary>
          <p>
            只比较同一预订、相同路线的样例候选；同行人保持相同航班。请明确选择客票，最后一段到达时间以UTC填写。报价不锁座。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () =>
                setComparison(
                  await api('/service/compare', {
                    ticket_ids: selected,
                    arrive_by_ms: deadline ? Date.parse(deadline + 'Z') : null,
                    max_collect_usd: budget || null,
                  }),
                ),
              );
            }}
          >
            {tickets
              .filter((t) => t.state === 'ACTIVE')
              .map((t) => (
                <label className="service-check" key={t.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(t.id)}
                    onChange={(e) => {
                      setComparison(null);
                      setSelected((ids) =>
                        e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                      );
                    }}
                  />
                  {t.id} · {t.traveler_name}
                </label>
              ))}
            <label>
              最后一段最迟到达（UTC，可不填）
              <input
                type="datetime-local"
                value={deadline}
                onChange={(e) => {
                  setDeadline(e.target.value);
                  setComparison(null);
                }}
              />
            </label>
            <label>
              最高总补款（USD，可不填）
              <input
                type="number"
                min="0"
                step="0.01"
                value={budget}
                onChange={(e) => {
                  setBudget(e.target.value);
                  setComparison(null);
                }}
              />
            </label>
            <button disabled={pending || !selected.length} type="submit">
              比较可用方案
            </button>
          </form>
          {comparison && (
            <>
              <p>{comparison.message}</p>
              {comparison.search_truncated && <p>本次仅检查部分样例组合，不宣称全网最优。</p>}
              {comparison.candidates.map((c: any, i: number) => (
                <article className="service-item" key={i}>
                  <b>
                    方案 {i + 1} · 总补款 ${moneyText(c.totals.collect)}
                  </b>
                  <p>
                    最后一段到达：{date(c.arrival_at_ms)}；原路应退 ${moneyText(c.totals.refund)}
                    ，旅行额度 ${moneyText(c.totals.credit)}。
                  </p>
                  {c.legs.map((l: any) => (
                    <p key={l.flight_id}>
                      {l.origin} → {l.destination} · {l.flight_id}
                      <br />
                      {date(l.departure_at_ms)} → {date(l.arrival_at_ms)}
                    </p>
                  ))}
                  <button disabled={pending} onClick={() => void onQuote(c.request)}>
                    选择此方案并重新报价
                  </button>
                </article>
              ))}
            </>
          )}
        </details>
      )}
      {operator && (
        <details className="service-item">
          <summary>模拟新的航班变动</summary>
          <p>
            为一张尚无航变的自营有效样票模拟延后180分钟；这会更新其版本，使旧报价不能执行。不会修改银行账目。
          </p>
          {data?.tickets
            ?.filter(
              (t: any) => t.channel === 'DIRECT' && t.state === 'ACTIVE' && t.can_simulate_delay,
            )
            .map((t: any) => (
              <div key={t.id}>
                <b>{t.id}</b>
                {t.segments
                  .filter((s: any) => s.state === 'UNUSED' && s.can_simulate_delay)
                  .map((s: any) => (
                    <button
                      key={s.id}
                      disabled={pending}
                      onClick={() =>
                        void act(() =>
                          api('/service/flight-event', {
                            ticket_id: t.id,
                            segment_id: s.id,
                            version: t.version,
                            request_key: `flight:${t.id}:${s.id}:${t.version}`,
                          }),
                        )
                      }
                    >
                      模拟 {s.id} 延后180分钟
                    </button>
                  ))}
              </div>
            ))}
        </details>
      )}
    </section>
  );
}
