import type { Airline } from '../domain/types.js';
import { baggage, type RuleSet } from '../domain/rules.js';
import { moneyText } from '../domain/money.js';

// Reviewed against the supplied §1–10. Other evidence releases require a new
// summary review; numeric tables always come from the active deterministic rules.
export function policySummary(airline: Airline, topics: string[], rules: RuleSet) {
  if (rules.knowledge_release !== '404f665e46351af9b4c4e50b')
    return { zh: [], en: [], baggage_allowances: [] };
  const zh: string[] = [],
    en: string[] = [];
  const add = (cn: string, english: string) => {
    zh.push(cn);
    en.push(english);
  };
  const has = (...values: string[]) => values.some((v) => topics.includes(v));
  if (has('change', 'refund', 'no_show', 'disruption'))
    add(
      '以下是政策条件说明，不是客票报价或办理结果。航变保护先于自愿退改限制；金额和资格仍需核对当前授权、使用状态、时间、税费与附加服务。',
      'These are policy conditions, not a ticket quotation or an executed operation. Qualifying disruptions override voluntary restrictions. Authorization, use, time, taxes and extras must still be checked.',
    );
  if (has('change', 'refund', 'scope'))
    add(
      '提前窗口含恰好 24 小时；临近窗口为起飞前不足 24 小时且大于 0。按完整、获授权且接受报价的请求接收时间判断，时间基准为 UTC。报价本身不保留资格。',
      'Early means at least 24 hours; late means more than zero and less than 24 hours before departure. Use the receipt time of the complete authorized request accepting the quotation, in UTC. A quote does not reserve eligibility.',
    );
  const scopes = airline === 'STA' ? (['STA_DOM', 'STA_INT'] as const) : [airline];
  if (has('change')) {
    add(
      '自愿改签按每人、每个变更航段、每次完成的请求计费；每段正票价差另付，降价不能抵其他段差价或手续费，也不产生退款/额度。税额增减单独原路收退。',
      'Voluntary change fees apply per traveler, changed segment and completed request. Add each positive segment fare difference; lower fares create no refund/credit and cannot offset other differences or fees. Tax changes are collected/refunded separately.',
    );
    for (const scope of scopes)
      for (const fare of ['Basic', 'Standard', 'Flex'] as const) {
        const [early, late] = rules.change[scope][fare];
        const routeZh = scope === 'STA_DOM' ? '国内段 ' : scope === 'STA_INT' ? '国际段 ' : '';
        const routeEn =
          scope === 'STA_DOM' ? 'domestic ' : scope === 'STA_INT' ? 'international ' : '';
        add(
          `${routeZh}${fare}：提前 ${early === null ? '不允许' : `USD ${early}`}；临近 ${late === null ? '不允许' : `USD ${late}`}。`,
          `${routeEn}${fare}: early ${early === null ? 'not permitted' : `USD ${early}`}; late ${late === null ? 'not permitted' : `USD ${late}`}.`,
        );
      }
    if (airline === 'BHA')
      add(
        'BHA Standard 原出票早于 2026-07-01 00:00 UTC 时提前改签费为 USD 85；等于或晚于该时刻为 USD 55。重签不会改变原出票时间，临近均不允许。',
        'BHA Standard: original issuance before 2026-07-01 00:00 UTC uses USD 85 early; at/after uses USD 55. Reissue does not reset original issuance. Late changes remain prohibited.',
      );
    add(
      '可保持票价类型或升档，不能降档；当前票价决定本次手续费，新票价决定以后请求。只改未飞航段，无误机才可按表办理；部分升档造成混合票价、换人/航司/路线或服务无法转移需审核。',
      'Retain or upgrade, never downgrade. The existing fare sets this change fee; the replacement fare governs later requests. Remaining unflown segments can be changed only without a no-show. Mixed-fare upgrades, passenger/airline/route changes or unavailable services require review.',
    );
  }
  if (has('refund')) {
    add(
      '以下为整张完全未用客票的自愿取消票价处理，按每人整票扣费、扣至零为止；按首段起飞判断窗口。Suntrail 含国际段的整票使用国际取消规则。',
      'Voluntary cancellation below concerns each wholly unused ticket. Deduct the fee per traveler/ticket, floored at zero, using the first departure window. A Suntrail itinerary containing an international segment uses international cancellation rules.',
    );
    for (const scope of scopes)
      for (const fare of ['Basic', 'Standard', 'Flex'] as const) {
        const entries = rules.cancel[scope][fare];
        const cn = entries.map(([d, f]) =>
          d === 'NONE'
            ? '票价不退'
            : `${d === 'CREDIT' ? '本人旅行额度' : '原路现金退款'}，扣 USD ${f}`,
        );
        const english = entries.map(([d, f]) =>
          d === 'NONE'
            ? 'fare nonrefundable'
            : `${d === 'CREDIT' ? 'personal travel credit' : 'original-payment refund'}, less USD ${f}`,
        );
        const route =
          scope === 'STA_DOM'
            ? '国内整票 / domestic'
            : scope === 'STA_INT'
              ? '含国际段 / international'
              : airline;
        add(
          `${route} ${fare}：提前 ${cn[0]}；临近 ${cn[1]}。`,
          `${route} ${fare}: early ${english[0]}; late ${english[1]}.`,
        );
      }
    add(
      '票价不退不等于税费不退：未使用政府税可单独申请原路退；自愿取消的行李/座位附加服务不退。部分已用、只退选段、历史价值不明需审核；代理出票退款经出票代理处理。有效乘机权益与独立退税冲突须先核定。',
      'Unused government taxes may be requested separately even if the fare is nonrefundable. Voluntary cancellation does not refund bag/seat extras. Partial use, selected-segment cancellation and unclear historical value require review. Agency refunds go through the issuing agency. Resolve active travel rights before standalone tax refunds.',
    );
  }
  if (has('disruption', 'change', 'refund', 'no_show'))
    add(
      `航司取消航段，或最新通知相对原出票确认时刻提前/延后至少 ${rules.disruption_minutes[airline]} 分钟（含等于），触发航变保护。通知后 30 个连续日内（含等于）选择：一次同航司、同目的地、同票价类型、原起飞 UTC 日期前后 7 日内的有位替代航班；或未用受影响行程退款。整票未用退票价、未用税及未用附加服务；部分已用保留未用受影响部分退款权，金额需审核。超 30 日需审核。接受替代后个人原因再改按正常规则；新合格航变产生新选择。`,
      `Cancellation or an absolute departure change of at least ${rules.disruption_minutes[airline]} minutes against original issuance qualifies. Within 30 elapsed days inclusive of notice, choose one available rebooking on the same airline, destination and fare within ±7 UTC calendar dates inclusive, or a refund of the unused affected journey. Wholly unused itineraries refund fare, unused taxes and extras. Partial use retains the unused affected portion right, with valuation reviewed. After 30 days review is required. Later personal changes use normal rules; a new qualifying event creates a new choice.`,
    );
  if (has('credit', 'refund'))
    add(
      '旅行额度只限具名旅客及签发行司，不可转让或提现。有效期为签发后 365 个连续日；兑换和新旅程起飞均必须早于到期时刻。本项目记录和核对额度，不支持兑换购票。',
      'Credit belongs to the named traveler and issuing airline, with no transfer or cash-out. It expires 365 elapsed days after issue; redemption and new travel start must both precede expiry. This demo records/checks credit but does not redeem it.',
    );
  if (has('no_show'))
    add(
      '起飞时仍未完成有效请求即进入误机规则：票价价值不退，后续航段暂停，不能自动恢复；未用税仍可申请。合格航变保护优先于误机损失规则。',
      'Without a complete valid request before departure, no-show rules apply: fare value is lost and remaining segments are suspended, with no automatic reinstatement. Unused taxes remain requestable. Qualifying disruption protection overrides no-show loss rules.',
    );
  if (has('extras'))
    add(
      '未使用附加服务在同一旅客、同路线的允许改签中可随行程转移，受服务可用性限制；无法提供时需审核，不自动改算赔偿。自愿取消不退附加服务，合格航变退款包含未用附加服务。',
      'Unused extras may transfer with permitted same-traveler/route changes, subject to availability; unavailable services require review without invented compensation. Voluntary cancellation forfeits extras; qualifying disruption refunds include unused extras.',
    );
  if (has('authorization'))
    add(
      '成人旅客只办理本人已核验客票。付款、同姓或掌握订单号不授予同行权限；代理需明确动作授权及身份核验，监护关系须人工核验。不要在此上传证件或完整银行卡资料。',
      'Verified adults handle their own tickets. Payment, shared surname or booking reference does not grant authority over others. Representatives need action-specific authorization and identity verification; guardianship requires manual verification. Do not upload identity documents or full card details here.',
    );
  if (has('review'))
    add(
      '严重医疗事件、部分使用退款、选段取消、混合票价、监护及权属争议需人工审核。申请不代表批准、免手续费或承诺退款，也无固定处理时限。本地申请仅保存待接入状态，不接收医疗记录；提交证明前须取得安全渠道。',
      'Serious medical events, partial refunds, selected-segment cancellation, mixed fares, guardianship and ownership disputes require review. An application does not guarantee approval, fee waiver, refund or turnaround. Local records await manual service; medical records are not collected. Obtain a secure channel before supplying evidence.',
    );
  const baggage_allowances: ReturnType<typeof baggage>[] = [];
  if (has('baggage')) {
    add(
      '行李按每人、每段计算，重量不可合并。个人物品免费 1 件、3 kg、40 × 30 × 15 cm；登机行李尺寸 55 × 35 × 25 cm；托运行李每件三边之和不超过 158 cm，尺寸包含把手和轮子，限值含等于。以下列明各票价适用额度；本期仅查询，不销售行李。',
      'Allowances are per person and segment; weights cannot be pooled. One free personal item: 3 kg, 40 × 30 × 15 cm. Cabin dimensions: 55 × 35 × 25 cm. Each checked bag: dimensions sum at most 158 cm. Handles/wheels count; limits are inclusive. Fare-specific allowances follow. This demo checks but does not sell baggage.',
    );
    for (const domestic of airline === 'STA' ? [true, false] : [true])
      for (const fare of ['Basic', 'Standard', 'Flex'] as const) {
        const b = baggage(airline, fare, domestic, [], rules);
        baggage_allowances.push(b);
        const routeZh = airline === 'STA' ? (domestic ? '国内段 ' : '国际段 ') : '';
        const routeEn = airline === 'STA' ? (domestic ? 'domestic ' : 'international ') : '';
        add(
          `${routeZh}${fare}：${b.cabin.count ? `免费登机行李 1 件、${b.cabin.kg} kg` : '无免费登机行李'}；${b.checked.count ? `免费托运行李 ${b.checked.count} 件、每件 ${b.checked.kg_each} kg` : '无免费托运行李'}。`,
          `${routeEn}${fare}: ${b.cabin.count ? `1 free cabin bag, ${b.cabin.kg} kg` : 'no free cabin bag'}; ${b.checked.count ? `${b.checked.count} free checked bag(s), ${b.checked.kg_each} kg each` : 'no free checked baggage'}.`,
        );
      }
    const b = baggage_allowances[0];
    add(
      `可另购 1 件托运行李，每件 ${b.extra_checked.kg} kg，三边和 ≤158 cm，USD ${moneyText(b.extra_checked.fee)} / 人 / 段；超过规定件数、重量或尺寸需人工核实，不能据此保证承运。`,
      `One additional checked bag may be bought: ${b.extra_checked.kg} kg, dimensions sum ≤158 cm, USD ${moneyText(b.extra_checked.fee)} per person/segment. Unpublished excess needs review and does not guarantee carriage.`,
    );
    if (b.paid_cabin)
      add(
        `BHA Basic 可另购 1 件登机行李，7 kg、55 × 35 × 25 cm，USD ${moneyText(b.paid_cabin.fee)} / 人 / 段。`,
        `BHA Basic may buy one cabin bag: 7 kg, 55 × 35 × 25 cm, USD ${moneyText(b.paid_cabin.fee)} per person/segment.`,
      );
  }
  if (has('scope'))
    add(
      '本服务仅覆盖给定三家虚构航司的已公布政策及模拟客票。奖励票、代码共享及团体合同不自动办理；没有可用历史政策时不套用现行政策。宠物、贵宾室和会员权益等未覆盖事项不能推定允许或禁止。',
      'Only the three supplied fictional policies and simulated tickets are covered. Award tickets, codeshares and group contracts are not automatically handled. Missing historical policy cannot be replaced with current rules. Uncovered pets, lounges and loyalty benefits imply neither permission nor prohibition.',
    );
  return { zh, en, baggage_allowances };
}
