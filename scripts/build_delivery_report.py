"""Render the authored handoff Markdown as a paginated Chinese PDF.

Report-only optional dependencies: reportlab. Not needed to run the application.
Uses local macOS fonts; set AIRLINE_REPORT_FONT / AIRLINE_REPORT_BOLD_FONT to
equivalent embeddable TrueType fonts on another authoring machine.
"""
from pathlib import Path
import html
import os
import re
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'docs/DELIVERY_REPORT.md'
output = ROOT / 'output/pdf/airline-delivery-report.pdf'
output.parent.mkdir(parents=True, exist_ok=True)
font = os.environ.get('AIRLINE_REPORT_FONT', '/System/Library/Fonts/STHeiti Light.ttc')
bold = os.environ.get('AIRLINE_REPORT_BOLD_FONT', '/System/Library/Fonts/STHeiti Medium.ttc')
pdfmetrics.registerFont(TTFont('ReportCJK', font, subfontIndex=0))
pdfmetrics.registerFont(TTFont('ReportCJKBold', bold, subfontIndex=0))
pdfmetrics.registerFontFamily('ReportCJK', normal='ReportCJK', bold='ReportCJKBold')
green, muted = colors.HexColor('#183E35'), colors.HexColor('#60796D')
body = ParagraphStyle('Body', fontName='ReportCJK', fontSize=9.8, leading=15.2,
                      textColor=green, wordWrap='CJK', spaceAfter=9)
heading = ParagraphStyle('Heading', parent=body, fontName='ReportCJKBold', fontSize=18,
                         leading=25, spaceBefore=6, spaceAfter=16, keepWithNext=True)
title = ParagraphStyle('Title', parent=heading, fontSize=25, leading=34, spaceAfter=8)
cell = ParagraphStyle('Cell', parent=body, fontSize=8.7, leading=13, spaceAfter=0)
code = ParagraphStyle('Code', parent=body, fontSize=9, leading=13, leftIndent=10,
                       backColor=colors.HexColor('#F0F4EC'), borderPadding=10, spaceAfter=15)
caption = ParagraphStyle('Caption', parent=body, fontSize=8.4, leading=12.5, textColor=muted)
width = A4[0] - 96


def inline(text):
    text = text.replace('\u2013', '-').replace('\u2014', '-').replace('\u2011', '-')
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    return text


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#D9E2D4'))
    canvas.line(48, A4[1] - 32, A4[0] - 48, A4[1] - 32)
    canvas.setFont('ReportCJK', 8)
    canvas.setFillColor(muted)
    canvas.drawString(48, A4[1] - 24, 'AIRLINE DESK  /  DELIVERY 2026.09.20')
    canvas.drawString(48, 24, '本地作业与服务试用 · 真实业务接入未包含')
    canvas.drawRightString(A4[0] - 48, 24, f'{doc.page:02d}')
    canvas.restoreState()


story = []
lines = source.read_text().splitlines()
i = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        i += 1
        continue
    if line == '<!-- PAGE -->':
        story.append(PageBreak()); i += 1; continue
    if line.startswith('```'):
        command_lines = []
        i += 1
        while i < len(lines) and not lines[i].startswith('```'):
            command_lines.append(html.escape(lines[i])); i += 1
        story.append(Paragraph('<br/>'.join(command_lines), code)); i += 1; continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            values = [x.strip() for x in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', x) for x in values):
                rows.append([Paragraph(inline(x), cell) for x in values])
            i += 1
        columns = [width * .29, width * .71] if len(rows[0]) == 2 else [width * .23, width * .35, width * .42]
        table = Table(rows, colWidths=columns, repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#DFE8D5')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7F2')]),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ('LINEBELOW', (0, 0), (-1, 0), .6, colors.HexColor('#B5C8AA')),
        ]))
        story.extend([table, Spacer(1, 12)]); continue
    image = re.fullmatch(r'!\[(.*?)\]\((.*?)\)', line)
    if image:
        item = Image(str((source.parent / image.group(2)).resolve()))
        scale = min(width / item.imageWidth, 310 / item.imageHeight)
        item.drawWidth = item.imageWidth * scale; item.drawHeight = item.imageHeight * scale
        item.hAlign = 'CENTER'
        story.extend([item, Spacer(1, 8)]); i += 1; continue
    if line.startswith('# '):
        story.append(Paragraph(inline(line[2:]), title))
    elif line.startswith('## '):
        story.append(Paragraph(inline(line[3:]), heading))
    else:
        story.append(Paragraph(inline(line), caption if line.startswith('图：') else body))
    i += 1

doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=48, rightMargin=48,
                        topMargin=49, bottomMargin=45,
                        title='Airline Desk 项目交付报告', author='Airline Desk 项目交付')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(output)
