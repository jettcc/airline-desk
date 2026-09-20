export const reasons: Record<string, [string, string]> = {
  POLICY_APPLIED: ['已按适用政策核算', 'Applicable policy evaluated'],
  DISRUPTION_PROTECTION: ['已采用航变保护规则', 'Disruption protection applied'],
  POLICY_DATE_NOT_COVERED: ['资料不覆盖该请求日期', 'Request date outside policy coverage'],
  INVALID_TICKET_FACTS: ['客票事实不完整或冲突', 'Ticket facts incomplete or conflicting'],
  INVALID_FINANCIAL_OR_TIME_FACTS: ['金额或时间事实不合法，需核实', 'Invalid amount or time facts'],
  DISRUPTION_WINDOW_REVIEW: [
    '已超航变通知处理窗口，需人工核定',
    'Disruption request window exceeded; review required',
  ],
  NO_UNUSED_DISRUPTION_RIGHT: ['没有可用的本次航变权益', 'No unused disruption entitlement'],
  CHOOSE_DISRUPTION_OPTION: [
    '请先选择免费改签或航变退款',
    'Choose free rebooking or disruption refund',
  ],
  FREE_REBOOK_OR_REFUND: [
    '可评估免费改签或航变退款',
    'Free rebooking or disruption refund may apply',
  ],
  TICKET_ALREADY_CANCELLED: ['客票已取消', 'Ticket already cancelled'],
  INVALID_SEGMENT_SELECTION: ['航段选择不合法', 'Invalid segment selection'],
  REFUND_THROUGH_TICKETING_AGENT: [
    '请通过原出票代理处理退款',
    'Refund must be handled by the ticketing agent',
  ],
  TAX_AND_ACTIVE_TRAVEL_CONFLICT: [
    '客票仍可出行，单独退税与出行权益需人工协调',
    'Tax refund conflicts with active travel; review required',
  ],
  UNUSED_TAX_REFUND_ELIGIBILITY: [
    '仍可评估未使用政府税退款',
    'Unused government taxes may remain refundable',
  ],
  NO_REMAINING_UNUSED_TAX: ['没有尚未退还的未用税费', 'No remaining unused tax refund'],
  MISSING_TAX_AMOUNT: ['缺少可信税额，暂不能报价', 'Verified tax amount missing'],
  PARTIAL_CANCELLATION_REVIEW: ['部分航段取消需要人工核定', 'Partial cancellation requires review'],
  NO_UNUSED_SEGMENTS: ['没有未使用航段可退款', 'No unused segments remain'],
  PARTIALLY_USED_REFUND_REVIEW: [
    '已用部分客票的退款需要人工核定',
    'Partly used ticket refund requires review',
  ],
  UNUSED_AFFECTED_PORTION_REFUND_RIGHT: [
    '未使用且受影响部分仍有适用退款权，金额待核定',
    'Eligible unused affected portion retains a refund right; amount pending review',
  ],
  HISTORICAL_VALUE_REVIEW: [
    '历史票价分摊不明确，需要核定',
    'Historical value allocation requires review',
  ],
  NO_SHOW_FARE_NOT_REFUNDABLE: [
    '已错过起飞窗口，不可自愿退票价',
    'No-show: voluntary fare refund unavailable',
  ],
  MISSING_PRICE_OR_TAX: ['缺少可信票价或税额', 'Verified fare or tax amount missing'],
  MULTI_PAYMENT_ALLOCATION_REVIEW: [
    '多支付记录退款分配需要人工核定',
    'Multiple-payment allocation requires review',
  ],
  NO_SHOW_REMAINING_SEGMENTS_SUSPENDED: [
    '已发生误机，剩余航段暂停，不可自动改签恢复',
    'No-show suspends remaining segments; automatic restoration unavailable',
  ],
  SELECT_REPLACEMENT_FLIGHTS: ['请先选择新的航班', 'Select replacement flights'],
  REPLACEMENT_NOT_FOUND: ['未找到所选航班或航段', 'Replacement or segment not found'],
  SEGMENT_ALREADY_USED: ['该航段已使用', 'Segment already flown'],
  ROUTE_CHANGE_REVIEW: [
    '更换航司或路线需要人工核定',
    'Airline or route substitution requires review',
  ],
  REPLACEMENT_ALREADY_DEPARTED: [
    '候选航班已经起飞或时间无效',
    'Replacement departed or has invalid times',
  ],
  DOWNGRADE_NOT_ALLOWED: ['不允许降低票价档次', 'Fare downgrade is not permitted'],
  MISSING_OR_CONSUMED_PRICE_ENTITLEMENT: [
    '票价或税费权益不完整或已使用，需要核定',
    'Price entitlement missing or already consumed',
  ],
  INVALID_OFFER: ['候选航班数据有误', 'Invalid offer facts'],
  EXTRA_SERVICE_UNAVAILABLE: [
    '原附加服务无法转移，需要人工核定',
    'Existing extra cannot be transferred; review required',
  ],
  DISRUPTION_REPLACEMENT_OUTSIDE_TERMS: [
    '候选航班超出航变保护允许条件',
    'Replacement outside disruption protection terms',
  ],
  CHANGE_NOT_ALLOWED_IN_WINDOW: [
    '当前时间窗口不允许该票价改签',
    'Change not permitted for this fare and time window',
  ],
  MIXED_FARE_UPGRADE_REVIEW: [
    '混合票价或部分升档需要人工核定',
    'Mixed-fare or partial upgrade requires review',
  ],
  ITINERARY_TIME_CONFLICT: ['新旧航段时间冲突', 'Itinerary times overlap'],
  BAG_OUTSIDE_PUBLISHED_ALLOWANCE: [
    '行李超出已公布范围，需要人工核定',
    'Baggage exceeds published limits; review required',
  ],
  WITHIN_ALLOWANCE: [
    '按提供的行李信息可适用以下规则',
    'The supplied baggage fits these published rules',
  ],
};
export const errors: Record<string, [string, string]> = {
  LOGIN_REQUIRED: ['请先登录账号。', 'Please sign in.'],
  AUTH_INVALID: ['用户名或密码不正确。', 'Incorrect username or password.'],
  USERNAME_TAKEN: ['用户名已被使用，请换一个。', 'This username is already taken.'],
  PASSWORD_MISMATCH: ['两次输入的密码不一致。', 'The passwords do not match.'],
  AUTH_RATE_LIMITED: ['操作过于频繁，请稍后再试。', 'Too many attempts. Please try again shortly.'],
  SESSION_EXPIRED: ['会话已过期，请重新选择身份。', 'Session expired. Please sign in again.'],
  TARGET_UNAVAILABLE: [
    '当前身份无法访问该对象，或对象不存在。',
    'The target is unavailable to this identity, or does not exist.',
  ],
  BUSINESS_HISTORY_RESTRICTED: [
    '相关授权已失效，此对话的业务历史已停用。请新建对话。',
    'A required authorization is no longer valid. This business history is restricted; start a new conversation.',
  ],
  CONVERSATION_BUSY: [
    '正在核对本次需求，请稍后再提交。',
    'This conversation is processing a request. Please wait.',
  ],
  QUOTE_EXPIRED: ['报价已超过有效期，请重新报价。', 'Quote expired. Request a new quotation.'],
  QUOTE_SUPERSEDED: [
    '此方案已被新的选择替代，请重新报价。',
    'This quote was superseded. Request a new quotation.',
  ],
  QUOTE_SESSION_CHANGED: [
    '登录会话已变化，请重新报价；已提交结果可在处理记录查询。',
    'Session changed. Get a new quote; existing submissions remain available in records.',
  ],
  FACTS_CHANGED: [
    '客票或航班信息发生变化，请重新报价。',
    'Ticket or flight facts changed. Request a new quotation.',
  ],
  POLICY_CHANGED: [
    '适用政策版本已变化，请重新报价。',
    'Applicable policy changed. Request a new quotation.',
  ],
  QUOTE_REQUIRES_REFRESH: [
    '当前条件不再满足原报价，请重新核算。',
    'Current conditions no longer match the quote. Recalculate.',
  ],
  SEATS_UNAVAILABLE: [
    '所选航班座位不足，未执行本次办理。',
    'Insufficient seats. This operation was not executed.',
  ],
  IDEMPOTENCY_KEY_REUSED: [
    '请求编号与原内容不一致，未重复执行。',
    'Request key does not match the original content.',
  ],
  MESSAGE_KEY_REUSED: [
    '消息编号与原内容不一致。',
    'Message key does not match the original content.',
  ],
  MODEL_NOT_CONFIGURED: [
    '模型未配置。仍可使用客票和处理记录入口。',
    'Model is not configured. Ticket and record tools remain available.',
  ],
  MODEL_QUOTA_OR_RATE_LIMIT: [
    '模型额度或调用频率受限，请稍后重试。已提交结果仍可查询。',
    'Model quota or rate limit reached. Submitted results remain available.',
  ],
  MODEL_BUSY: ['当前咨询较多，请稍后重试。', 'The assistant is busy. Please try again shortly.'],
  MODEL_QUEUE_TIMEOUT: ['咨询等待超时，请稍后重试。', 'Assistant queue timed out. Please retry.'],
  MODEL_CONNECTION_FAILED: [
    '模型连接暂不可用，本轮尚未完成。已提交结果仍可查询。',
    'The model connection is unavailable. This turn is incomplete; submitted records remain available.',
  ],
  MODEL_TIMEOUT: ['模型响应超时，本轮尚未完成。', 'Model timed out; this turn is incomplete.'],
  MODEL_INCOMPLETE: [
    '模型响应中断，本轮尚未完成。',
    'Model response was interrupted; this turn is incomplete.',
  ],
  ASSISTANT_UNAVAILABLE: [
    '本轮咨询暂未完成，请重试。已提交操作请查处理记录。',
    'This turn is incomplete. Retry, or check records for already submitted operations.',
  ],
  SERVICE_UNAVAILABLE: [
    '服务暂时无法核实结果，请保留原请求编号查询。',
    'The service cannot verify the result. Keep the original request key for recovery.',
  ],
  NETWORK: [
    '连接中断，结果尚未核实，请查询原请求。',
    'Connection interrupted. Result unverified; recover the original request.',
  ],
  INVALID_INPUT: [
    '输入格式不完整或不正确，请检查后重试。',
    'Input is incomplete or invalid. Please check it.',
  ],
  CSRF_REQUIRED: [
    '页面会话已变化，请刷新后重试。',
    'Page session changed. Refresh before retrying.',
  ],
  SESSION_OR_AUTHORIZATION_CHANGED: [
    '身份或授权已变化，旧回复已丢弃。',
    'Identity or authorization changed; old response discarded.',
  ],
};
Object.assign(reasons, {
  MEDICAL_EVIDENCE_REVIEW: [
    '医疗例外申请尚未核验；请先取得安全提交渠道，不要在聊天中上传病历。标准规则仍适用，不保证免手续费或退款。',
    'The medical exception is unverified. Obtain a secure evidence channel; do not upload records in chat. Standard rules still apply; no waiver or refund is guaranteed.',
  ],
  GUARDIANSHIP_EVIDENCE_REVIEW: [
    '监护关系须人工核验；此申请不授予查询或办理他人客票的权限。',
    'Guardianship needs manual verification. This record grants no access to another traveler’s tickets.',
  ],
  OWNERSHIP_EVIDENCE_REVIEW: [
    '权属争议须人工核验；申请记录不证明客票存在或操作权限成立。',
    'Ownership needs manual verification. A record proves neither ticket existence nor authority.',
  ],
});
Object.assign(errors, {
  SERVICE_OPERATOR_REQUIRED: [
    '需要切换到独立的模拟客服身份。',
    'A separate demo service operator is required.',
  ],
  TRAVELER_ROLE_REQUIRED: ['请切换回旅客身份办理。', 'Switch back to a traveler identity.'],
  REGISTERED_ACCOUNT_REQUIRED: [
    '请先注册并登录自己的本地账号，再申请找回样例客票。',
    'Register and sign in before requesting sample ticket access.',
  ],
  ACCESS_PROOF_INVALID: [
    '样例客票或演示验证码不正确。',
    'Invalid sample ticket or demonstration code.',
  ],
  ACCESS_REQUEST_EXPIRED: [
    '样例核验申请已过期，请重新申请。',
    'The sample verification request expired.',
  ],
  SERVICE_VERSION_CHANGED: [
    '此事项已被更新，请刷新进度后再操作。',
    'This item changed. Refresh before continuing.',
  ],
  INVALID_SERVICE_TRANSITION: [
    '当前状态不支持此操作，请刷新查看下一步。',
    'This action is not available in the current state.',
  ],
  CASE_OWNED_BY_ANOTHER_OPERATOR: [
    '该事项由另一位模拟客服接手。',
    'Another operator owns this case.',
  ],
  SERVICE_NOTE_REQUIRED: [
    '请填写具体处理理由或非敏感补充信息。',
    'Provide a reason or non-sensitive supporting information.',
  ],
  ORDER_RECEIPT_REQUIRED: [
    '订单处理尚未确认完成，不能将退款标为受理或到账。',
    'An order completion receipt is required before refund progress.',
  ],
  SERVICE_RESULT_PENDING: [
    '这张票还有未核对完成的渠道任务。请到服务中心查询原请求，不要重复办理。',
    'A channel result is pending. Recover the original request in the service center.',
  ],
  CHANNEL_HANDOFF_REQUIRED: [
    '此票由外部代理出票，超出自营试用范围。请在服务中心创建转办申请，由原出票渠道核定。',
    'This ticket requires its issuing channel; request a handoff in the service center.',
  ],
  FLIGHT_EVENT_NOT_APPLICABLE: [
    '这张票或航段目前不适用该模拟航变事件。',
    'This flight-event scenario does not apply to the current ticket.',
  ],
  COMPLEX_ITINERARY_REQUIRES_REVIEW: [
    '这些客票的路线不一致或过于复杂，请申请人工核对，不会拆开同行人。',
    'The itinerary needs review; travelers will not be silently split.',
  ],
  INVALID_ARRIVAL_DEADLINE: [
    '请填写未来的、明确的UTC到达截止时间。',
    'Enter an explicit future arrival deadline in UTC.',
  ],
  INVALID_BUDGET: [
    '请填写非负、最多两位小数的美元预算。',
    'Enter a nonnegative USD budget with at most two decimals.',
  ],
  ACCESS_APPROVAL_NOT_APPLICABLE: [
    '此申请不能通过样例找票流程批准。',
    'This request cannot be approved through sample ticket verification.',
  ],
});
export const label = (code: string, lang: string) =>
  reasons[code]?.[lang === 'en' ? 1 : 0] ??
  (lang === 'en' ? 'Further review is required.' : '需要进一步核实。');
export const errorLabel = (code: string, lang: string) =>
  errors[code]?.[lang === 'en' ? 1 : 0] ?? errors.ASSISTANT_UNAVAILABLE[lang === 'en' ? 1 : 0];
