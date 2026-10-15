#!/usr/bin/env python3
"""Synthetic layout diagnostic, not a real-video accuracy benchmark.
Usage: generate-caption-fixtures.py OUTPUT_DIRECTORY NOTO_SANS_CJK_FONT
Font source: https://github.com/notofonts/noto-cjk (font is not redistributed).
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import sys, json, hashlib
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
font_path=Path(sys.argv[2]);font=ImageFont.truetype(str(font_path),36)
scenes=[('zh', [('编剧',(500,125)),('林明',(500,195)),('周禾',(500,265)),('跟着歌声向前走',(500,495))]),
        ('en', [('Written by',(500,125)),('Ada North',(500,195)),('We can start now',(500,495))])]
frames=[];expected={}
for scene, lines in scenes:
    for index in range(3):
        name=f'{scene}-{index}';im=Image.new('RGBA',(1000,600),(22+index,30+index,40+index,255));draw=ImageDraw.Draw(im)
        for text, xy in lines:draw.text(xy,text,font=font,anchor='mm',fill=(255,255,255,255))
        (out/f'{name}.rgba').write_bytes(im.tobytes())
        frames.append({'name':name,'rgba':f'{name}.rgba','width':1000,'height':600})
    expected[scene]={'credits':[t for t,_ in lines[:-1]],'caption':lines[-1][0]}
(out/'frames.json').write_text(json.dumps(frames,indent=2))
(out/'expected.json').write_text(json.dumps({'scope':'synthetic clean typography only; no original video, sound, motion, blur or accents','font_sha256':hashlib.sha256(font_path.read_bytes()).hexdigest(),'expected':expected},ensure_ascii=False,indent=2))
print('Prepared 6 synthetic OCR frames')
