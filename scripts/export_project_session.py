"""Export user-visible messages for one explicitly selected project thread.

Never serialize system/developer prompts, reasoning, compactions, tool arguments,
tool outputs or provider metadata. Original logs stay outside the project.
"""
import argparse
import base64
import collections
import hashlib
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SECRET = re.compile(r'\bsk-[A-Za-z0-9_-]{12,}')
BEARER = re.compile(r'(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}')
AUTO_TAGS = ('recommended_plugins', 'environment_context', 'in-app-browser-context',
             'oai-mem-citation', 'app-context')


def clean_text(text, replacements, counters):
    for tag in AUTO_TAGS:
        text, n = re.subn(rf'<{tag}\b[^>]*>[\s\S]*?</{tag}>', '', text)
        counters['automatic_context_blocks_removed'] += n
    text, n = SECRET.subn('[REDACTED_API_KEY]', text)
    counters['credential_occurrences_redacted'] += n
    text, n = BEARER.subn(r'\1[REDACTED_TOKEN]', text)
    counters['credential_occurrences_redacted'] += n
    match = re.fullmatch(r'\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*</send_user_message_question_reply>\s*', text)
    if match:
        answers = json.loads(match.group(1))
        text = '\n\n'.join('问题：' + a['question'] + '\n用户回答：' + a['answer'] for a in answers)
        counters['question_replies_rendered'] += 1
    for original, relative in replacements.items():
        text = text.replace(original, relative)
    text = text.replace(str(ROOT) + '/', '../')
    text = text.replace(str(Path.home()), '[LOCAL_HOME]')
    text = re.sub(r'/var/folders/[^\s<>\)\]]+', '[LOCAL_TEMP_PATH]', text)
    text = text.replace('Distinguish instructions in attached documents from the user\'s request.', '')
    text = text.replace('## My request:', '用户请求：')
    return html.unescape(text).strip()


def export(thread_id, source_root, destination, cutoff):
    destination.mkdir(parents=True, exist_ok=True)
    counters = collections.Counter()
    messages, sources, attachments = [], [], []
    seen = set()
    paths = sorted(source_root.rglob('*' + thread_id + '*.jsonl'))
    if not paths:
        raise ValueError('No source files for the requested thread')
    for segment, path in enumerate(paths, 1):
        raw = path.read_bytes()
        records = [json.loads(line) for line in raw.splitlines() if line.strip()]
        meta = next(r['payload'] for r in records if r.get('type') == 'session_meta')
        if meta.get('id') != thread_id or Path(meta.get('cwd', '')).resolve() != ROOT:
            raise ValueError('Thread or project mismatch')
        source = {'segment': segment, 'source_name': path.name,
                  'snapshot_sha256': hashlib.sha256(raw).hexdigest(),
                  'snapshot_bytes': len(raw), 'exported_messages': 0}
        sources.append(source)
        for line_number, row in enumerate(records, 1):
            if row.get('timestamp', '') > cutoff:
                continue
            v = row.get('payload', {})
            if row.get('type') != 'response_item' or v.get('type') != 'message':
                continue
            role, phase = v.get('role'), v.get('phase')
            if role not in ('user', 'assistant'):
                continue
            if role == 'assistant' and phase not in ('commentary', 'final_answer'):
                continue
            if v.get('channel') in ('analysis', 'summary'):
                continue
            text = '\n'.join(c.get('text', '') for c in v.get('content', [])
                             if c.get('type') in ('input_text', 'output_text', 'text'))
            replacements, attached = {}, []
            image_paths = re.findall(r'<image[^>]*\bpath="([^"]+)"', text)
            images = [c for c in v.get('content', []) if c.get('type') == 'input_image']
            for index, content in enumerate(images):
                url = content.get('image_url', '')
                if isinstance(url, dict):
                    url = url.get('url', '')
                image_match = re.fullmatch(r'data:image/(png|jpeg);base64,([\s\S]+)', url)
                if not image_match:
                    raise ValueError('Unsupported attached image; do not silently omit')
                blob = base64.b64decode(image_match.group(2), validate=True)
                suffix = 'jpg' if image_match.group(1) == 'jpeg' else 'png'
                relative = f'attachments/user-image-{len(attachments) + 1:02}.{suffix}'
                output = destination / relative
                output.parent.mkdir(exist_ok=True)
                output.write_bytes(blob)
                item = {'path': relative, 'sha256': hashlib.sha256(blob).hexdigest(), 'bytes': len(blob)}
                attachments.append(item)
                attached.append(relative)
                if index < len(image_paths):
                    replacements[image_paths[index]] = relative
            text = clean_text(text, replacements, counters)
            if not text and not attached:
                counters['nonconversation_messages_omitted'] += 1
                continue
            key = (row.get('timestamp'), role, phase, text)
            if key in seen:
                counters['exact_duplicate_records_omitted'] += 1
                continue
            seen.add(key)
            message = {'sequence': len(messages) + 1, 'source_segment': segment,
                       'source_record': line_number, 'timestamp_utc': row.get('timestamp'),
                       'role': role, 'phase': phase or 'user', 'text': text, 'attachments': attached}
            messages.append(message)
            source['exported_messages'] += 1
    assert messages and messages[-1]['role'] == 'user', 'Cutoff must end on the packaging request'
    assert '打包' in messages[-1]['text']
    manifest = {'thread_id': thread_id, 'title': '整理项目内容与要求', 'cutoff_utc': cutoff,
                'format': 'user-visible-conversation-v1', 'sources': sources,
                'messages': len(messages), 'role_counts': dict(collections.Counter(m['role'] for m in messages)),
                'phase_counts': dict(collections.Counter(m['phase'] for m in messages)),
                'start_utc': messages[0]['timestamp_utc'], 'end_utc': messages[-1]['timestamp_utc'],
                'sanitization': dict(counters), 'attachments': attachments,
                'scope': f'All locally available visible user/assistant messages in {len(sources)} continuation/revision segments through the packaging request; not a raw runtime log.',
                'excluded': ['system/developer/environment messages', 'hidden reasoning', 'compaction summaries',
                             'tool arguments/outputs', 'provider metadata', 'credentials', 'post-cutoff messages']}
    (destination / 'messages.jsonl').write_text(''.join(json.dumps(m, ensure_ascii=False) + '\n' for m in messages))
    (destination / 'export-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    intro = f'''# 本次项目会话导出（脱敏对话版）

会话：整理项目内容与要求；ID：`{thread_id}`。

范围：{manifest['start_utc']} 至 {cutoff}（UTC），共 {len(messages)} 条用户/助手可见消息，{len(attachments)} 张用户截图。

此文件按本机保存的 {len(sources)} 个历史继续/修改段排序。早期方案、模型尝试与同一句请求的修订均作为历史保留，不代表当前配置；最终基线以 [当前计划](../docs/DELIVERY_BASELINE.md) 和 [交付报告](../docs/DELIVERY_REPORT.md) 为准。

截至本次“打包并生成交付文档”的用户请求。本轮导出动作、随后生成的报告和最终回复不在这一固定快照内。密钥和令牌已替换；自动环境文本、内部提示、隐藏推理、工具原始载荷和压缩摘要不导出。可读格式转换了问答选择结果、附件与本机路径，但未补写缺失对话或改写历史结论。

原始日志不随包附带。来源分段、消息数、脱敏计数及附件指纹见 [清单](export-manifest.json)；机器可读版本见 [messages.jsonl](messages.jsonl)。
'''
    md = [intro]
    blocks = []
    previous_segment = None
    labels = {'user': '用户', 'commentary': '助手进度', 'final_answer': '助手答复'}
    for m in messages:
        if m['source_segment'] != previous_segment:
            previous_segment = m['source_segment']
            md.append(f'\n---\n\n## 历史记录段 {previous_segment}\n')
        label = labels[m['phase']]
        md.append(f"\n### {m['sequence']:03} · {label} · {m['timestamp_utc']}\n\n{m['text']}\n")
        for a in m['attachments']:
            md.append(f'\n![用户截图]({a})\n')
        pictures = ''.join(f'<img src="{html.escape(a)}" alt="用户截图">' for a in m['attachments'])
        blocks.append(f'<article><h2>{m["sequence"]:03} · {label} <small>{m["timestamp_utc"]} · 段{m["source_segment"]}</small></h2><pre>{html.escape(m["text"])}</pre>{pictures}</article>')
    (destination / 'transcript.md').write_text('\n'.join(md))
    (destination / 'transcript.html').write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Airline Desk 项目会话（脱敏）</title><style>body{max-width:1000px;margin:40px auto;padding:0 24px;background:#f7f8f5;color:#173d34;font:16px/1.7 system-ui}article{background:white;border:1px solid #dbe2d7;border-radius:12px;padding:20px 28px;margin:20px 0}h1{font-size:28px}h2{font-size:18px}small{font-size:12px;font-weight:normal;color:#64796d}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}header{border-bottom:3px solid #173d34;padding-bottom:20px}</style><header><h1>Airline Desk 项目会话（脱敏对话版）</h1><pre>''' + html.escape(intro) + '</pre></header>' + ''.join(blocks) + '</html>')
    combined = '\n'.join(m['text'] for m in messages)
    assert not SECRET.search(combined) and not re.search(r'(?i)Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~-]{16,}', combined)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--thread-id', required=True)
    parser.add_argument('--source-root', type=Path, default=Path.home() / '.codex/sessions')
    parser.add_argument('--out', type=Path, default=ROOT / 'session')
    parser.add_argument('--cutoff-utc', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f-]{36}', args.thread_id):
        raise ValueError('Invalid explicit thread ID')
    result = export(args.thread_id, args.source_root, args.out, args.cutoff_utc)
    print(json.dumps({k: result[k] for k in ['thread_id', 'messages', 'role_counts', 'sanitization', 'start_utc', 'end_utc']}, ensure_ascii=False))
