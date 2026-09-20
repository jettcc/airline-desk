import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { moneyText } from '../src/domain/money';
import { label, errorLabel } from './i18n';
import './style.css';
import { ServicePanel, ServiceOverview, serviceState } from './service';
const money = (m: any) => (m ? `$${moneyText(m)}` : '—');
const actionNames: Record<string, [string, string]> = {
  CHANGE: ['改签', 'Change'],
  CANCEL: ['取消并按明细处理', 'Cancel and process breakdown'],
  TAX_REFUND: ['申请未用税退款', 'Refund unused taxes'],
  DISRUPTION_CHANGE: ['航变免费改签', 'Disruption rebooking'],
  DISRUPTION_REFUND: ['航变退款', 'Disruption refund'],
};
const directionNames: Record<string, [string, string]> = {
  COLLECT: ['应收', 'Collect'],
  REFUND: ['原路应退', 'Refund to original method'],
  CREDIT: ['本人旅行额度', 'Personal travel credit'],
  FORFEIT: ['不退部分', 'Nonrefundable'],
};
const kindNames: Record<string, [string, string]> = {
  CHANGE_FEE: ['改签费', 'Change fee'],
  FARE_DIFFERENCE: ['正票价差', 'Positive fare difference'],
  FARE: ['票价', 'Fare'],
  TAX: ['政府税', 'Government tax'],
  EXTRA: ['附加服务', 'Extra service'],
  CANCELLATION_FEE: ['取消费扣除', 'Cancellation deduction'],
};
function App() {
  const [boot, setBoot] = useState<any>(null),
    [lang, setLang] = useState('zh'),
    [zone, setZone] = useState('UTC'),
    [conv, setConv] = useState<any>(null),
    [turns, setTurns] = useState<any[]>([]),
    [input, setInput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(false),
    [showService, setShowService] = useState(false),
    [authTab, setAuthTab] = useState<'login' | 'register' | 'demo'>('login'),
    [authUsername, setAuthUsername] = useState(''),
    [authName, setAuthName] = useState(''),
    [authPassword, setAuthPassword] = useState(''),
    [authConfirm, setAuthConfirm] = useState(''),
    [authError, setAuthError] = useState(''),
    [authPending, setAuthPending] = useState(false),
    [extraCards, setExtraCards] = useState<any[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [offers, setOffers] = useState<Record<string, string>>({}),
    [pending, setPending] = useState<string[]>([]),
    [now, setNow] = useState(Date.now()),
    [confirming, setConfirming] = useState<string | null>(null);
  const csrf = useRef(''),
    session = useRef(''),
    generation = useRef(0),
    end = useRef<HTMLDivElement>(null),
    timeBase = useRef({ server: Date.now(), client: Date.now(), frozen: false }),
    convRef = useRef('');
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh),
    an = (a: string) => actionNames[a]?.[lang === 'en' ? 1 : 0] ?? a;
  const date = (ms: number) =>
    new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'zh-CN', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms)) + ` ${zone}`;
  async function api(path: string, body?: any) {
    const r = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await r.json();
    if (!r.ok)
      throw Object.assign(new Error(data.error ?? 'SERVICE_UNAVAILABLE'), { status: r.status });
    return data;
  }
  async function initialize(forceNew = false, preferredConversation?: string) {
    const g = ++generation.current;
    setBusy(false);
    setShowService(false);
    setConfirming(null);
    setTurns([]);
    setExtraCards([]);
    setSelected([]);
    setOffers({});
    setError('');
    try {
      const b = await api('/bootstrap');
      if (g !== generation.current) return;
      csrf.current = b.csrf;
      session.current = b.session_id;
      setBoot(b);
      timeBase.current = { server: b.now_ms, client: Date.now(), frozen: b.frozen_clock };
      setNow(b.now_ms);
      const owner = b.actor?.id ?? b.session_id;
      setPending(JSON.parse(localStorage.getItem('airline-pending:' + owner) ?? '[]'));
      const list = forceNew ? [] : await api('/conversations');
      const available = list.find((c: any) => !c.frozen);
      const c = preferredConversation
        ? { id: preferredConversation }
        : (available ?? (await api('/conversations', {})));
      if (g !== generation.current) return;
      convRef.current = c.id;
      await refresh(c.id, g);
    } catch (e) {
      setError(e instanceof TypeError ? 'NETWORK' : e instanceof Error ? e.message : 'NETWORK');
    }
  }
  async function refresh(cid = convRef.current, g = generation.current) {
    const h = await api('/conversations/' + cid);
    if (g !== generation.current || cid !== convRef.current) return;
    setConv(h.conversation);
    setTurns(h.turns);
    setBusy(!!h.conversation.busy_turn_id);
    if (
      h.conversation.active_quote_id &&
      !h.turns.some((t: any) =>
        t.response?.cards?.some(
          (c: any) => c.kind === 'quote' && c.data.id === h.conversation.active_quote_id,
        ),
      )
    ) {
      try {
        const q = await api('/quotes/' + h.conversation.active_quote_id);
        if (g === generation.current)
          setExtraCards((cs) =>
            cs.some((c) => c.kind === 'quote' && c.data.id === q.id)
              ? cs
              : [...cs, { kind: 'quote', data: q }],
          );
      } catch {}
    }
  }
  useEffect(() => {
    void initialize();
    const interval = setInterval(() => {
      const t = timeBase.current;
      setNow(t.server + (t.frozen ? 0 : Date.now() - t.client));
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const g = generation.current;
    const timer = setInterval(() => {
      void refresh(convRef.current, g).catch((e) => {
        setBusy(false);
        setError(e.message);
      });
    }, 900);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, extraCards.length, busy]);
  useEffect(() => {
    const check = async () => {
      try {
        const b = await api('/bootstrap');
        if (b.session_id !== session.current) await initialize();
      } catch {}
    };
    window.addEventListener('focus', check);
    const timer = setInterval(check, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    const g = generation.current;
    setError('');
    try {
      await fn();
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof TypeError ? 'NETWORK' : e instanceof Error ? e.message : 'NETWORK');
    }
  }
  async function send(message = input) {
    if (!message.trim() || busy || !conv) return;
    const g = generation.current;
    setInput('');
    setBusy(true);
    setExtraCards([]);
    setError('');
    try {
      await api(`/conversations/${conv.id}/turns`, { message, message_key: crypto.randomUUID() });
      await refresh(conv.id, g);
    } catch (e) {
      if (g === generation.current) {
        setBusy(false);
        setError(e instanceof TypeError ? 'NETWORK' : e instanceof Error ? e.message : 'NETWORK');
      }
    }
  }
  function clearAuthSecrets() {
    setAuthPassword('');
    setAuthConfirm('');
    setAuthError('');
  }
  function openIdentity() {
    clearAuthSecrets();
    setAuthUsername('');
    setAuthName('');
    setAuthTab('login');
    setModal(true);
  }
  function openDemo() {
    openIdentity();
    setAuthTab('demo');
  }
  function startDemo(prompt: string) {
    setInput(prompt);
    if (boot?.accounts.some((a: any) => a.id === boot.actor?.id)) void send(prompt);
    else openDemo();
  }
  function closeIdentity() {
    if (authPending) return;
    clearAuthSecrets();
    setModal(false);
  }
  async function authenticate(path: string, values: any) {
    if (authPending) return;
    setAuthPending(true);
    setAuthError('');
    try {
      const result = await api(path, {
        ...values,
        ...(conv?.id && path !== '/demo/service-desk' ? { conversation_id: conv.id } : {}),
      });
      clearAuthSecrets();
      setModal(false);
      await initialize(true, result.conversation_id);
      if (path === '/demo/service-desk') setShowService(true);
    } catch (e) {
      setAuthError(e instanceof TypeError ? 'NETWORK' : e instanceof Error ? e.message : 'NETWORK');
      setAuthPassword('');
      setAuthConfirm('');
    } finally {
      setAuthPending(false);
    }
  }
  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    if (authTab === 'register' && authPassword !== authConfirm) {
      setAuthError('PASSWORD_MISMATCH');
      return;
    }
    await authenticate('/auth/' + authTab, {
      username: authUsername,
      password: authPassword,
      ...(authTab === 'register' && authName.trim() ? { display_name: authName.trim() } : {}),
    });
  }
  function recordPending(key: string, remove = false) {
    const owner = boot.actor?.id ?? boot.session_id;
    const list: string[] = JSON.parse(localStorage.getItem('airline-pending:' + owner) ?? '[]');
    const next = remove ? list.filter((x) => x !== key) : [...new Set([...list, key])];
    localStorage.setItem('airline-pending:' + owner, JSON.stringify(next));
    setPending(next);
  }
  async function confirm(q: any) {
    if (confirming) return;
    const g = generation.current;
    const storageKey = 'airline-confirm:' + boot.actor.id + ':' + q.id;
    let key = localStorage.getItem(storageKey);
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem(storageKey, key);
    }
    recordPending(key);
    setConfirming(q.id);
    await run(async () => {
      let result;
      try {
        result = await api('/confirm', {
          quote_id: q.id,
          confirmation_token: q.confirmation_token,
          request_key: key,
        });
      } catch (e) {
        if (g === generation.current && (e as any)?.status >= 400 && (e as any)?.status < 500)
          recordPending(key!, true);
        throw e;
      }
      if (g !== generation.current) return;
      setExtraCards((cs) => [...cs, { kind: 'submission', data: result }]);
      if (['SUCCEEDED', 'REJECTED', 'INTERRUPTED'].includes(result.state))
        recordPending(key!, true);
      await refresh();
    });
    if (g === generation.current) setConfirming(null);
  }
  async function recover(key: string) {
    await run(async () => {
      const g = generation.current;
      const result = await api('/submissions/' + encodeURIComponent(key));
      if (g !== generation.current) return;
      setExtraCards((cs) => [...cs, { kind: 'submission', data: result }]);
      if (['SUCCEEDED', 'REJECTED', 'INTERRUPTED'].includes(result.state)) recordPending(key, true);
      await refresh();
    });
  }
  async function directQuote(action: string, targets: any[]) {
    await run(async () => {
      const g = generation.current;
      const r = await api('/quotes', { conversation_id: conv.id, request: { action, targets } });
      if (g !== generation.current) return;
      setExtraCards([{ kind: r.quote ? 'quote' : 'decision', data: r.quote ?? r.decision }]);
      await refresh();
    });
  }
  function Sources({
    sources,
    bundle,
    release,
  }: {
    sources: any[];
    bundle?: string;
    release?: string;
  }) {
    const unique = [...new Map((sources ?? []).map((s) => [s.airline + ':' + s.page, s])).values()];
    return (
      <div className="sources">
        {unique.map((s) => (
          <a
            key={s.airline + ':' + s.page}
            href={`${bundle ? '/api/bundle-source/' + bundle : '/api/policies/' + (release ?? boot?.release_id)}/${s.airline}.pdf#page=${s.page}`}
            target="_blank"
            rel="noreferrer"
          >
            ↗ {s.airline} · {tr('第', 'p. ')}
            {s.page}
            {tr('页', '')}
          </a>
        ))}
      </div>
    );
  }
  function Totals({ data }: { data: any }) {
    return (
      <div className="totals">
        {Object.entries({
          collect: 'COLLECT',
          refund: 'REFUND',
          credit: 'CREDIT',
          forfeit: 'FORFEIT',
        }).map(([k, d]) => (
          <div key={k} className={k}>
            <small>{directionNames[d][lang === 'en' ? 1 : 0]}</small>
            <strong>
              {money(data[k])}
              <i> USD</i>
            </strong>
          </div>
        ))}
      </div>
    );
  }
  function Lines({ lines }: { lines: any[] }) {
    return (
      <div className="lines">
        {lines.map((l, i) => (
          <div className="line" key={i}>
            <span>
              {kindNames[l.kind]?.[lang === 'en' ? 1 : 0]}
              <small>
                {l.ticket_id}
                {l.segment_id ? ' · ' + l.segment_id : ''}
              </small>
              <small>
                {l.payment_ref
                  ? tr('模拟原支付渠道', 'Simulated original payment') +
                    ' · ' +
                    l.payment_ref.replace(/^PAY-/, '•• ')
                  : ''}
              </small>
            </span>
            <span>
              {directionNames[l.direction]?.[lang === 'en' ? 1 : 0]} <b>{money(l.amount)}</b>
            </span>
          </div>
        ))}
      </div>
    );
  }
  function Decision({ d }: { d: any }) {
    const statuses: Record<string, [string, string]> = {
      ALLOWED: ['方案可用，等待明确确认', 'Available; explicit confirmation required'],
      DENIED: ['该方案不适用', 'This option is not permitted'],
      NEEDS_INFO: ['还需要补充信息', 'More information needed'],
      MANUAL_REVIEW: ['需要人工核定', 'Manual review required'],
      CONFLICT: ['事实存在冲突', 'Conflicting facts'],
      NOT_COVERED: ['资料未覆盖', 'Not covered'],
    };
    return (
      <>
        <h3>{statuses[d.status]?.[lang === 'en' ? 1 : 0]}</h3>
        {[...d.reasons, ...d.known_rights].map((r: string) => (
          <p key={r}>{label(r, lang)}</p>
        ))}
        {d.status === 'ALLOWED' && (
          <>
            <Totals data={d.totals} />
            <Lines lines={d.lines} />
          </>
        )}
        {d.status === 'MANUAL_REVIEW' && (
          <p className="notice">
            {tr(
              '金额待核定；当前未执行退改或资金处理。',
              'Amount pending review. No booking or financial operation executed.',
            )}
          </p>
        )}
      </>
    );
  }
  function TicketList({ tickets }: { tickets: any[] }) {
    return (
      <>
        <h3>
          {tr('可访问的客票', 'Accessible tickets')} <span className="count">{tickets.length}</span>
        </h3>
        {tickets.length === 0 && (
          <div className="notice">
            {tr(
              '当前账号暂无客票。可以继续咨询政策，或从右上角的“体验示例”查看虚构旅程。',
              'This account has no tickets yet. You can ask policy questions or use Try demo in the account menu to explore fictional journeys.',
            )}
            <button className="text-button" onClick={openDemo}>
              {tr('选择虚构旅客，体验办理', 'Choose a fictional traveler')}
            </button>
          </div>
        )}
        <p className="muted">
          {tr(
            '只显示当前身份有权查看的范围。选择一张或同一预订内的多张票。',
            'Only tickets authorized for this identity are shown. Select tickets within one booking.',
          )}
        </p>
        <div className="ticket-list">
          {tickets.map((t) => (
            <label className={'ticket ' + (selected.includes(t.id) ? 'selected' : '')} key={t.id}>
              <input
                type="checkbox"
                aria-label={t.id}
                checked={selected.includes(t.id)}
                onChange={() =>
                  setSelected((s) =>
                    s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id],
                  )
                }
              />
              <div>
                <strong>
                  {t.id}{' '}
                  <em>
                    {t.airline} · {t.fare_type}
                  </em>
                </strong>
                <p>
                  {t.traveler_name} · {t.booking_id} ·{' '}
                  {t.state === 'CANCELLED'
                    ? tr('已取消', 'Cancelled')
                    : t.state === 'SUSPENDED'
                      ? tr('暂停', 'Suspended')
                      : tr('有效', 'Active')}
                </p>
                {t.segments.map((s: any) => (
                  <small key={s.id}>
                    {s.origin} → {s.destination}　{date(s.departure_at_ms)}　
                    {s.state === 'USED'
                      ? tr('已飞', 'Flown')
                      : s.state === 'NO_SHOW'
                        ? tr('误机', 'No-show')
                        : s.state === 'SUSPENDED'
                          ? tr('暂停', 'Suspended')
                          : tr('未使用', 'Unused')}
                  </small>
                ))}
                {t.disruption && !t.disruption.consumed && (
                  <span className="tag amber">{tr('有航变信息', 'Disruption reported')}</span>
                )}
              </div>
            </label>
          ))}
        </div>
        {selected.length > 0 && (
          <div className="selection">
            <b>
              {tr('已选择', 'Selected')}: {selected.join(', ')}
            </b>
            <div className="button-row">
              {['CHANGE', 'CANCEL', 'DISRUPTION_CHANGE', 'DISRUPTION_REFUND', 'TAX_REFUND'].map(
                (a) => (
                  <button
                    key={a}
                    disabled={busy}
                    onClick={() =>
                      void send(
                        `${lang === 'en' ? 'Please assess' : '请评估'} ${selected.join(', ')} ${an(a)}${a.endsWith('CHANGE') ? tr('，请给我可选的新航班。', ', and show available replacement flights.') : ''}`,
                      )
                    }
                  >
                    {an(a)}
                  </button>
                ),
              )}
            </div>
          </div>
        )}
      </>
    );
  }
  function Options({ data }: { data: any }) {
    const tickets = data.tickets ?? [data];
    const selectedTargets = tickets.map((t: any) => ({
      ticket_id: t.ticket_id,
      segment_ids: [],
      replacements: t.segments
        .filter((s: any) => offers[s.segment_id])
        .map((s: any) => ({ segment_id: s.segment_id, offer_id: offers[s.segment_id] })),
    }));
    return (
      <>
        <h3>
          {tr('选择新的航班', 'Select replacement flights')} ·{' '}
          {tickets.map((t: any) => t.ticket_id).join(', ')}
        </h3>
        <p className="muted">
          {tr(
            '每位选定旅客至少选择一个要变更的航段，统一报价和确认；座位在确认时复核。',
            'Choose at least one changed segment per selected traveler for a combined quotation and confirmation. Seats are rechecked at confirmation.',
          )}
        </p>
        {tickets.map((t: any) => (
          <div key={t.ticket_id}>
            <h4>{t.ticket_id}</h4>
            {t.segments.map((s: any) => (
              <div className="option-group" key={s.segment_id}>
                <label>
                  {s.segment_id}
                  <select
                    aria-label={s.segment_id}
                    value={offers[s.segment_id] ?? ''}
                    onChange={(e) => setOffers((o) => ({ ...o, [s.segment_id]: e.target.value }))}
                  >
                    <option value="">{tr('保留原航段 / 请选择', 'Keep original / select')}</option>
                    {s.offers.map((o: any) => (
                      <option key={o.id} value={o.id}>
                        {o.origin}→{o.destination} · {date(o.departure_at_ms)} · {o.fare_type} ·{' '}
                        {tr('票价', 'fare')} {money(o.fare)} + {tr('税', 'tax')} {money(o.tax)} ·{' '}
                        {tr('余位', 'seats')} {o.seats_available}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        ))}
        <button
          className="primary"
          disabled={busy || selectedTargets.some((t: any) => !t.replacements.length)}
          onClick={() =>
            void send(
              tr(
                '请为以下明确选定的新航班报价：',
                'Please quote these explicitly selected replacement flights: ',
              ) + JSON.stringify({ action: data.action ?? 'CHANGE', targets: selectedTargets }),
            )
          }
        >
          {tr('查看改签报价', 'Get change quote')}
        </button>
      </>
    );
  }
  function QuoteCard({ q }: { q: any }) {
    const active =
      conv?.active_quote_id === q.id && q.session_id === boot?.session_id && q.expires_at_ms > now;
    return (
      <>
        <div className="card-eyebrow">
          {tr('待确认 · 尚未执行', 'AWAITING CONFIRMATION · NOT EXECUTED')}
        </div>
        <h3>{an(q.request.action)}</h3>
        {q.request.targets.map((t: any) => {
          const ticket = q.display?.tickets.find((x: any) => x.id === t.ticket_id);
          return (
            <div className="quote-target" key={t.ticket_id}>
              <b>
                {t.ticket_id} · {ticket?.traveler_name} · {ticket?.fare_type}
              </b>
              {t.replacements.map((r: any) => {
                const old = ticket?.segments.find((s: any) => s.id === r.segment_id),
                  o = q.display?.offers.find((x: any) => x.id === r.offer_id);
                return (
                  <p key={r.segment_id}>
                    {old?.origin} → {old?.destination}
                    <small>
                      {tr('原', 'From')} {old ? date(old.departure_at_ms) : r.segment_id}
                      <br />
                      {tr('新', 'To')} {o ? date(o.departure_at_ms) : r.offer_id} · {o?.fare_type}
                    </small>
                  </p>
                );
              })}
            </div>
          );
        })}
        <Totals data={q.decision.totals} />
        <Lines lines={q.decision.lines} />
        <p className="muted">
          {tr('有效至', 'Valid until')} {date(q.expires_at_ms)} ·{' '}
          {active
            ? tr('剩余', 'Remaining') +
              ' ' +
              Math.max(0, Math.ceil((q.expires_at_ms - now) / 1000)) +
              's'
            : tr('已失效或已有后续处理', 'No longer confirmable')}
        </p>
        <Sources sources={q.decision.sources} bundle={q.bundle_id} />
        <p className="notice">
          {tr(
            '模拟办理。确认时会重新校验政策、权限、客票和座位；报价不锁座，也不保留政策时间窗口。',
            'Simulated operation. Policy, authorization, tickets and seats are rechecked at confirmation. The quote does not reserve seats or a policy window.',
          )}
        </p>
        <button
          className="primary confirm"
          disabled={!active || busy || !!confirming}
          onClick={() => void confirm(q)}
        >
          {confirming === q.id
            ? tr('正在核实提交…', 'Verifying submission…')
            : busy
              ? tr('正在核对本次需求', 'Processing this conversation')
              : tr('确认', 'Confirm ') + an(q.request.action)}
        </button>
      </>
    );
  }
  function Operation({ op }: { op: any }) {
    return (
      <>
        <div className="success-title">
          ✓{' '}
          {op.service_tracking?.state === 'PENDING'
            ? tr('本地办理已登记 · 渠道结果待核对', 'Recorded locally · Channel result pending')
            : tr('模拟办理已完成', 'Simulated operation completed')}
        </div>
        <h3>{an(op.action)}</h3>
        <p className="reference">{op.id}</p>
        <p>
          {date(op.created_at_ms)} · {op.tickets.map((t: any) => t.id).join(', ')}
        </p>
        <details>
          <summary>{tr('办理后的客票', 'Tickets after this operation')}</summary>
          {op.tickets.map((t: any) => (
            <div key={t.id}>
              <b>
                {t.id} · {t.fare_type} ·{' '}
                {t.state === 'CANCELLED' ? tr('已取消', 'Cancelled') : tr('有效', 'Active')}
              </b>
              {t.segments.map((s: any) => (
                <p key={s.id}>
                  {s.flight_id} · {s.origin} → {s.destination} · {date(s.departure_at_ms)}
                </p>
              ))}
            </div>
          ))}
        </details>
        <Totals data={op.totals} />
        <details>
          <summary>{tr('查看资金明细', 'View financial breakdown')}</summary>
          <Lines lines={op.lines} />
        </details>
        {op.credits?.map((c: any) => (
          <div className="notice" key={c.id}>
            {tr('本人旅行额度', 'Personal travel credit')} {money(c.amount)} · {c.airline}
            <br />
            {tr('签发', 'Issued')} {date(c.issued_at_ms)}
            <br />
            {tr('到期', 'Expires')} {date(c.expires_at_ms)}
            <p>
              {tr(
                '仅限本人及该航司；兑换和新行程起飞均须在到期前。本期记录额度，不提供兑换功能。',
                'Named traveler and same airline only. Redemption and new departure must precede expiry. Credit is recorded; redemption is outside this version.',
              )}
            </p>
          </div>
        ))}
        <Sources sources={op.sources} bundle={op.bundle_id} />
        {op.service_tracking?.tasks?.length > 0 && (
          <>
            <ServiceOverview data={op.service_tracking} date={date} />
            <button onClick={() => setShowService(true)}>
              {tr('查看最新服务进度', 'View current service progress')}
            </button>
          </>
        )}
      </>
    );
  }
  function Card({ card }: { card: any }) {
    const d = card.data;
    return (
      <section className={'card ' + card.kind} data-card={card.kind}>
        {card.kind === 'clarification' && <p>{lang === 'en' ? d.en : d.zh}</p>}
        {card.kind === 'error' && <p role="alert">{errorLabel(d.code, lang)}</p>}
        {card.kind === 'tickets' && <TicketList tickets={d} />}
        {card.kind === 'service' && (
          <>
            <ServiceOverview data={d} date={date} />
            <button onClick={() => setShowService(true)}>打开服务中心查看最新状态</button>
          </>
        )}
        {card.kind === 'credit_check' && (
          <>
            <h3>{tr('旅行额度核对', 'Travel credit check')}</h3>
            <p>
              {d.id} · {money(d.amount)} · {d.airline}
            </p>
            <p>
              {tr('拟乘航班', 'Proposed travel')}: {d.requested_airline} ·{' '}
              {date(d.requested_departure_at_ms)}
            </p>
            <p>
              {d.usable_for_named_traveler
                ? tr(
                    '符合当前具名旅客、航司和时间条件。',
                    'Meets the named traveler, airline and time conditions.',
                  )
                : tr(
                    '不符合航司或有效期条件，不能用于该行程。',
                    'Airline or validity conditions are not met for this journey.',
                  )}
            </p>
            <p className="notice">
              {tr(
                '本期仅核对，不兑换购票；未扣减额度。',
                'Check only. Redemption is not supported; no credit was consumed.',
              )}
            </p>
          </>
        )}
        {['options', 'group_options'].includes(card.kind) && <Options data={d} />}
        {card.kind === 'quote' && <QuoteCard q={d} />}
        {card.kind === 'decision' && (
          <>
            <Decision d={d} />
            <Sources sources={d.sources} bundle={d.bundle_id} />
          </>
        )}
        {card.kind === 'baggage' && (
          <>
            <div className="card-eyebrow">
              {d.airline} · {d.fare_type}
              {d.airline === 'STA'
                ? ' · ' + (d.domestic ? tr('国内段', 'Domestic') : tr('国际段', 'International'))
                : ''}
            </div>
            <h3>{tr('你的行李规则', 'Your baggage allowance')}</h3>
            <div className="allowances">
              <div>
                <span>01</span>
                <b>{tr('个人物品', 'Personal item')}</b>
                <strong>1 × {d.personal.kg} kg</strong>
                <small>{d.personal.dimensions.join(' × ')} cm</small>
              </div>
              <div>
                <span>02</span>
                <b>{tr('登机行李', 'Cabin bag')}</b>
                <strong>
                  {d.cabin.count ? `1 × ${d.cabin.kg} kg` : tr('无免费额度', 'No free allowance')}
                </strong>
                <small>{d.cabin.dimensions.join(' × ')} cm</small>
              </div>
              <div>
                <span>03</span>
                <b>{tr('托运行李', 'Checked bag')}</b>
                <strong>
                  {d.checked.count
                    ? `${d.checked.count} × ${d.checked.kg_each} kg`
                    : tr('无免费额度', 'No free allowance')}
                </strong>
                <small>
                  {tr('每件三边之和 ≤', 'Dimensions sum per bag ≤')} {d.checked.sum_cm} cm
                </small>
              </div>
            </div>
            {d.paid_cabin && (
              <p>
                {tr('可另购一件登机行李', 'Optional cabin bag')}: {d.paid_cabin.kg} kg · 55 × 35 ×
                25 cm · {money(d.paid_cabin.fee)}
              </p>
            )}
            <p>
              {tr('可另购一件托运行李', 'One additional checked bag')}: {d.extra_checked.kg} kg ·{' '}
              {tr('三边和 ≤ 158 cm', 'dimensions sum ≤ 158 cm')} · {money(d.extra_checked.fee)}
            </p>
            <p className="muted">
              {tr(
                '可购费用均为每人、每航段；重量不可合并。本期提供规则与评估，不办理行李购买。',
                'Optional fees are per person, per segment. Weight cannot be pooled. Purchases are not available in this demo.',
              )}
            </p>
            {d.evaluated_bag_count > 0 && (
              <p className="notice">
                {d.status === 'MANUAL_REVIEW'
                  ? label(d.reason, lang)
                  : tr(
                      '本次行李组合需另付（每人、每段）：',
                      'Extra fee for these bags (per person, per segment): ',
                    ) + money(d.extra_fee_per_person_per_segment)}
              </p>
            )}
            <Sources sources={d.sources} bundle={d.bundle_id} />
          </>
        )}
        {card.kind === 'policy' && (
          <>
            <h3>{tr('政策依据', 'Policy evidence')}</h3>
            {d.parts.map((p: any) => (
              <div key={p.release_id}>
                {p.status !== 'FOUND' && (
                  <p className="notice">
                    {p.status === 'NEEDS_CONTEXT'
                      ? tr(
                          '请补充航司或明确比较范围。',
                          'Specify an airline or request a comparison.',
                        )
                      : tr(
                          '现有资料不足以完整回答，不能据此认定允许或禁止。',
                          'The supplied documents do not fully answer this. Absence of evidence is not permission or prohibition.',
                        )}
                  </p>
                )}
                {p.summaries?.map((summary: any) => (
                  <div key={summary.airline}>
                    <h4>{summary.airline}</h4>
                    {(lang === 'en' ? summary.en : summary.zh).map((line: string, i: number) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                ))}
                <p className="muted">
                  {tr(
                    '以下为已核对的英文原文。具体客票能否办理、金额多少，仍需按客票事实核算。',
                    'Reviewed source excerpts follow. Ticket eligibility and amounts require a separate assessment of booking facts.',
                  )}
                </p>
                {p.evidence.map((e: any) => (
                  <details key={e.id}>
                    <summary>
                      {e.airline} · §{e.section} · {e.title}{' '}
                      <a href={e.url} target="_blank" rel="noreferrer">
                        ↗ PDF
                      </a>
                    </summary>
                    <p className="excerpt">{e.text}</p>
                    {e.tables?.map((table: any, index: number) => (
                      <div className="table-scroll" key={index}>
                        <table>
                          <tbody>
                            {(table.rows ?? table).map((row: any, n: number) => (
                              <tr key={n}>
                                {row.map((cell: any, k: number) => (
                                  <td key={k}>{String(cell ?? '')}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </details>
                ))}
              </div>
            ))}
          </>
        )}
        {card.kind === 'review' && (
          <>
            <div className="card-eyebrow">
              {d.workflow
                ? serviceState(d.workflow.state)
                : tr('已记录 · 待人工接入', 'RECORDED · AWAITING MANUAL REVIEW')}
            </div>
            <h3>{tr('审核申请已保存', 'Review application saved')}</h3>
            <p className="reference">{d.id}</p>
            {d.restricted ? (
              <p>
                {tr(
                  '相关业务内容已因授权变化停用。',
                  'Business details are restricted after authorization changes.',
                )}
              </p>
            ) : (
              <>
                {d.decision?.known_rights.map((r: string) => (
                  <p key={r}>{label(r, lang)}</p>
                ))}
                {d.decision?.reasons.map((r: string) => (
                  <p key={r}>{label(r, lang)}</p>
                ))}
                <p className="notice">
                  {tr(
                    '金额待核定。客票及资金尚未变更；这是本地审核记录，目前没有接入真实客服。',
                    'Amount pending review. Ticket and funds are unchanged. This local record is not connected to a real service desk.',
                  )}
                </p>
                <Sources sources={d.decision?.sources ?? []} bundle={d.bundle_id} />
                {d.workflow && (
                  <>
                    <p>
                      {d.workflow.owner} · {d.workflow.next_step}
                    </p>
                    <button onClick={() => setShowService(true)}>查看申请与补充信息</button>
                  </>
                )}
              </>
            )}
          </>
        )}
        {card.kind === 'operations' && (
          <>
            {d.length ? (
              d.map((o: any) => <Operation key={o.id} op={o} />)
            ) : (
              <p>{tr('当前没有可查看的已完成操作。', 'No completed operations are available.')}</p>
            )}
          </>
        )}
        {card.kind === 'submission' &&
          (d.operation ? (
            <Operation op={d.operation} />
          ) : (
            <>
              <h3>
                {['REJECTED', 'INTERRUPTED'].includes(d.state)
                  ? tr('本次未完成办理', 'Operation not completed')
                  : tr('结果尚未核实', 'Result not yet verified')}
              </h3>
              <p>
                {d.error
                  ? errorLabel(d.error, lang)
                  : tr(
                      '请保留原请求编号，继续查询；不要据此重复办理。',
                      'Keep the original request key and check again before taking further action.',
                    )}
              </p>
              <p className="reference">{d.submission_id}</p>
            </>
          ))}
      </section>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Airline Desk">
          <span className="brand-icon">↗</span>
          <span>
            airline<span className="brand-light">desk</span>
            <small>YOUR JOURNEY, UNDERSTOOD</small>
          </span>
        </a>
        <div className="sidebar-title">{tr('旅程服务', 'JOURNEY SERVICES')}</div>
        <button className="nav active" onClick={() => void initialize(true)}>
          <span>＋</span>
          {tr('新的对话', 'New conversation')}
        </button>
        <button
          className="nav"
          disabled={busy || !boot?.actor}
          title={!boot?.actor ? tr('登录后可查看客票', 'Sign in to view your tickets') : undefined}
          onClick={() =>
            boot?.actor
              ? void run(async () => {
                  const g = generation.current;
                  const d = await api('/tickets');
                  if (g === generation.current) {
                    setShowService(false);
                    setExtraCards([{ kind: 'tickets', data: d }]);
                  }
                })
              : openIdentity()
          }
        >
          <span>▤</span>
          {tr('我的客票', 'My tickets')}
        </button>
        <button
          className="nav"
          disabled={!boot?.actor}
          title={
            !boot?.actor ? tr('登录后可查看处理记录', 'Sign in to view your activity') : undefined
          }
          onClick={() =>
            boot?.actor
              ? void run(async () => {
                  const g = generation.current;
                  const [ops, reviews] = await Promise.all([api('/operations'), api('/reviews')]);
                  if (g === generation.current) {
                    setShowService(false);
                    setExtraCards([
                      { kind: 'operations', data: ops },
                      ...reviews.map((data: any) => ({ kind: 'review', data })),
                    ]);
                  }
                })
              : openIdentity()
          }
        >
          <span>◷</span>
          {tr('处理记录', 'Activity & recovery')}
        </button>
        {boot?.service_trial && (
          <button
            className="nav"
            disabled={!boot.actor || busy}
            onClick={() => setShowService(true)}
          >
            <span>◎</span>
            {boot.service_operator ? '模拟客服工作台' : '我的服务中心'}
          </button>
        )}
        <div className="sidebar-note">
          <span className="tiny-label">THREE AIRLINES. ONE DESK.</span>
          <p>
            Northstar Air
            <br />
            Bluehaven Airways
            <br />
            Suntrail Air
          </p>
          <div className="source-status">
            <i />
            {tr('基于项目提供的政策 PDF', 'Grounded in supplied policy PDFs')}
          </div>
        </div>
        <div className="sidebar-bottom">
          <span className="tag">{tr('本地模拟 · 无真实扣款', 'LOCAL DEMO · NO REAL CHARGES')}</span>
          <p>{tr('不知道时，我们会明确告诉你。', 'When the evidence is missing, we say so.')}</p>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="online-dot" />
            {tr('航旅服务助手', 'Travel support assistant')}
            <small>
              {boot?.model.mode === 'real'
                ? boot.model.name
                : tr('模型未配置 / 测试模式', 'Model unconfigured / test mode')}
            </small>
          </div>
          <div className="header-actions">
            <button
              className="text-button demo-entry"
              disabled={!boot || authPending || busy}
              onClick={openDemo}
            >
              {tr('体验示例', 'Try demo')}
            </button>
            <select aria-label="Timezone" value={zone} onChange={(e) => setZone(e.target.value)}>
              <option>UTC</option>
              <option>Asia/Shanghai</option>
              <option>America/New_York</option>
            </select>
            <button
              className="text-button"
              onClick={() => setLang((l) => (l === 'zh' ? 'en' : 'zh'))}
            >
              {lang === 'zh' ? 'EN' : '中文'}
            </button>
            <button className="identity" disabled={!boot || authPending} onClick={openIdentity}>
              <span className="avatar">{boot?.actor ? '○' : '◌'}</span>
              {boot?.actor?.name ?? tr('游客 · 登录', 'Guest · Sign in')}
            </button>
          </div>
        </header>
        <div className="chat-scroll">
          {showService && boot?.actor ? (
            <ServicePanel
              key={boot.session_id}
              api={api}
              operator={boot.service_operator}
              samples={boot.sample_access ?? []}
              date={date}
              onBack={() => setShowService(false)}
              onTickets={() => {
                setShowService(false);
                void run(async () => {
                  const g = generation.current;
                  const d = await api('/tickets');
                  if (g === generation.current) setExtraCards([{ kind: 'tickets', data: d }]);
                });
              }}
              onQuote={async (request) => {
                setShowService(false);
                await directQuote(request.action, request.targets);
              }}
            />
          ) : (
            <div className="conversation">
              <div className="eyebrow">
                AIRLINE DESK / {tr('让每一步都有依据', 'EVERY STEP, WITH CLARITY')}
              </div>
              {boot?.service_trial && (
                <p className="notice">
                  服务试用已开启 ·
                  仅自营样例渠道。办理后请到“我的服务中心”核对模拟渠道结果；客服演示入口在“体验示例”中。
                </p>
              )}
              {boot?.frozen_clock && (
                <div className="notice">
                  {tr('演示使用冻结时钟', 'Frozen demonstration clock')}:{' '}
                  {new Date(now).toISOString()}
                </div>
              )}
              {turns.length === 0 && extraCards.length === 0 && (
                <div className="welcome">
                  <span className="welcome-mark">✧</span>
                  <h1>{tr('下一程，从清楚开始。', 'A clearer way to your next journey.')}</h1>
                  <p>
                    {tr(
                      '查清政策，算明费用，再决定下一步。',
                      'Understand the policy. See the numbers. Then decide.',
                    )}
                    <br />
                    {tr(
                      '退改、行李、航班变动，我来帮你逐项确认。',
                      'Changes, baggage and disruptions — one verified step at a time.',
                    )}
                  </p>
                  <div className="suggestions">
                    {[
                      [
                        tr('行李能带多少？', 'What baggage can I bring?'),
                        tr('行李能带多少？', 'What baggage can I bring?'),
                        '↗',
                      ],
                      [
                        tr('体验改签流程', 'Try a flight change'),
                        tr(
                          '我想改签，请先显示我有权查看的客票，让我选择。',
                          'I want to change a flight. Show my authorized tickets so I can choose.',
                        ),
                        'demo',
                      ],
                      [
                        tr('体验取消与退款', 'Try cancellation and refund'),
                        tr(
                          '我想取消并了解退款，请先显示我有权查看的客票，让我选择。',
                          'I want to cancel and understand the refund. Show my authorized tickets so I can choose.',
                        ),
                        'demo',
                      ],
                    ].map(([title, prompt, icon]) => (
                      <button
                        key={title}
                        aria-label={title}
                        disabled={busy || !boot}
                        onClick={() => (icon === 'demo' ? startDemo(prompt) : void send(prompt))}
                      >
                        <span>{title}</span>
                        <span>↗</span>
                      </button>
                    ))}
                  </div>
                  <div className="welcome-foot">
                    <span>✓ {tr('原文可查', 'Sources you can open')}</span>
                    <span>✓ {tr('费用逐项列明', 'Itemized amounts')}</span>
                    <span>✓ {tr('确认后才办理', 'You confirm before action')}</span>
                  </div>
                </div>
              )}
              {turns.map((t) => (
                <React.Fragment key={t.id}>
                  <div className="user-message">{t.request.message}</div>
                  <div className="assistant-message">
                    <div className="assistant-avatar">↗</div>
                    <div className="response">
                      <div className="response-name">
                        Airline Desk{' '}
                        <small>
                          {t.response?.model_mode === 'mock' ? tr('测试替身', 'TEST DOUBLE') : ''}
                        </small>
                      </div>
                      {t.state === 'RUNNING' ? (
                        <p className="progress">
                          {tr(
                            '正在理解需求并核对资料…',
                            'Understanding your request and checking the facts…',
                          )}
                        </p>
                      ) : t.response?.cards?.length ? (
                        t.response.cards.map((c: any, n: number) => <Card key={n} card={c} />)
                      ) : (
                        <p>
                          {tr(
                            '本轮已中断或因权限变化停用，请重试。',
                            'This turn was interrupted or restricted. Please retry.',
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              ))}
              {extraCards.length > 0 && (
                <div className="assistant-message">
                  <div className="assistant-avatar">↗</div>
                  <div className="response">
                    <div className="response-name">Airline Desk</div>
                    {extraCards.map((c, n) => (
                      <Card card={c} key={n} />
                    ))}
                  </div>
                </div>
              )}
              {pending.length > 0 && (
                <div className="pending">
                  <b>{tr('有待核实的提交', 'Submissions awaiting verification')}</b>
                  {pending.map((k) => (
                    <div key={k}>
                      <small>{k}</small>
                      <button onClick={() => void recover(k)}>
                        {tr('查询原请求', 'Recover request')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {error && (
                <div className="error-banner" role="alert">
                  {errorLabel(error, lang)}{' '}
                  {['SESSION_EXPIRED', 'CSRF_REQUIRED'].includes(error) && (
                    <button onClick={() => void initialize()}>
                      {tr('刷新会话', 'Refresh session')}
                    </button>
                  )}
                </div>
              )}
              <div ref={end} />
            </div>
          )}
        </div>
        {!showService && (
          <footer>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label={tr('消息', 'Message')}
                placeholder={tr('说说你想咨询或办理什么…', 'Tell me what you would like to do…')}
                value={input}
                maxLength={4000}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                type="submit"
                aria-label={tr('发送', 'Send')}
                disabled={busy || !input.trim() || !conv}
              >
                ↑
              </button>
            </form>
            <p>
              {tr(
                '公开咨询无需登录 · 涉及个人客票时核验身份 · 所有资金处理均为模拟',
                'Public questions need no login · Private tickets require identity · All financial operations are simulated',
              )}
            </p>
          </footer>
        )}
      </main>
      {modal && (
        <div className="modal-backdrop" onClick={closeIdentity}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr('账号登录与注册', 'Account sign in and registration')}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeIdentity();
            }}
          >
            <button
              className="close"
              disabled={authPending}
              onClick={closeIdentity}
              aria-label={tr('关闭', 'Close')}
            >
              ×
            </button>
            <div className="eyebrow">YOUR ACCOUNT</div>
            <h2>
              {boot?.actor
                ? tr('账号与身份', 'Account and identity')
                : tr('欢迎来到 Airline Desk', 'Welcome to Airline Desk')}
            </h2>
            {boot?.actor && (
              <p>
                {tr('当前登录：', 'Signed in: ')}
                <strong>{boot.actor.name}</strong>
              </p>
            )}
            <div
              className="auth-tabs"
              role="tablist"
              aria-label={tr('登录方式', 'Sign-in options')}
            >
              {(['login', 'register', 'demo'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={authTab === tab}
                  disabled={authPending}
                  onClick={() => {
                    setAuthTab(tab);
                    clearAuthSecrets();
                  }}
                >
                  {tab === 'login'
                    ? tr('登录', 'Sign in')
                    : tab === 'register'
                      ? tr('注册', 'Register')
                      : tr('体验示例', 'Try demo')}
                </button>
              ))}
            </div>
            {authTab !== 'demo' ? (
              <form className="auth-form" onSubmit={(e) => void submitAuth(e)}>
                <label>
                  {tr('用户名', 'Username')}
                  <input
                    autoFocus
                    name="username"
                    autoComplete="username"
                    value={authUsername}
                    onChange={(e) => setAuthUsername(e.target.value)}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9_]{3,32}"
                    disabled={authPending}
                    aria-describedby="username-help"
                  />
                </label>
                <small id="username-help">
                  {tr(
                    '3–32 位字母、数字或下划线，不区分大小写。',
                    '3–32 letters, numbers or underscores; case insensitive.',
                  )}
                </small>
                {authTab === 'register' && (
                  <label>
                    {tr('昵称（可选）', 'Display name (optional)')}
                    <input
                      name="display-name"
                      autoComplete="nickname"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      maxLength={40}
                      disabled={authPending}
                    />
                  </label>
                )}
                <label>
                  {tr('密码', 'Password')}
                  <input
                    type="password"
                    name="password"
                    autoComplete={authTab === 'register' ? 'new-password' : 'current-password'}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    required
                    minLength={authTab === 'register' ? 8 : 1}
                    maxLength={128}
                    disabled={authPending}
                  />
                </label>
                {authTab === 'register' && (
                  <>
                    <small>{tr('密码需 8–128 个字符。', 'Use 8–128 characters.')}</small>
                    <label>
                      {tr('确认密码', 'Confirm password')}
                      <input
                        type="password"
                        name="confirm-password"
                        autoComplete="new-password"
                        value={authConfirm}
                        onChange={(e) => setAuthConfirm(e.target.value)}
                        required
                        minLength={8}
                        maxLength={128}
                        disabled={authPending}
                      />
                    </label>
                  </>
                )}
                {authError && (
                  <div className="auth-error" role="alert">
                    {errorLabel(authError, lang)}
                  </div>
                )}
                <button className="primary" type="submit" disabled={authPending}>
                  {authPending
                    ? tr('正在处理…', 'Please wait…')
                    : authTab === 'register'
                      ? tr('注册并登录', 'Create account and sign in')
                      : tr('登录账号', 'Sign in to account')}
                </button>
                <p>
                  {authTab === 'register'
                    ? tr(
                        '账号保存在本机。新账号暂无客票；可通过“体验示例”查看虚构旅程。',
                        'Accounts are saved on this device. New accounts have no tickets; try a demo identity to explore fictional journeys.',
                      )
                    : tr(
                        '使用在这台设备注册的账号登录。',
                        'Sign in with an account registered on this device.',
                      )}
                </p>
              </form>
            ) : (
              <>
                <p>
                  {tr(
                    '以下均为虚构身份，仅用于体验样例客票，与个人注册账号分开。',
                    'These fictional identities provide sample tickets and are separate from your personal account.',
                  )}
                </p>
                <p className="notice">
                  {tr(
                    '首次体验可选林怡：登录后发送输入框中的问题，或点击“我的客票”选择一张票，再查看退改方案。所有办理均需你另行确认。',
                    'Start with Lin Yi. Send the prepared question or open My tickets, select a ticket and view its options. Every operation needs separate confirmation.',
                  )}
                </p>
                {boot?.accounts.map((a: any) => (
                  <button
                    className="account"
                    disabled={authPending}
                    key={a.id}
                    onClick={() => void authenticate('/login', { actor_id: a.id })}
                  >
                    {a.name}
                    <span>→</span>
                  </button>
                ))}
                {boot?.service_trial && (
                  <details className="notice">
                    <summary>模拟客服角色（本机演示）</summary>
                    <p>
                      此入口切换到独立客服身份，用于接单及模拟渠道回执，不是生产员工登录，也不会联系真实航司或银行。
                    </p>
                    {[1, 2].map((n) => (
                      <button
                        key={n}
                        className="account"
                        disabled={authPending}
                        onClick={() =>
                          void authenticate('/demo/service-desk', { operator: `demo-desk-${n}` })
                        }
                      >
                        模拟客服 {n}
                      </button>
                    ))}
                  </details>
                )}
                {authError && (
                  <div className="auth-error" role="alert">
                    {errorLabel(authError, lang)}
                  </div>
                )}
              </>
            )}
            {boot?.actor && (
              <button
                className="text-button logout"
                disabled={authPending}
                onClick={() =>
                  void run(async () => {
                    await api('/logout', {});
                    clearAuthSecrets();
                    setModal(false);
                    await initialize(true);
                  })
                }
              >
                {tr('退出，作为游客继续', 'Sign out and continue as guest')}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
