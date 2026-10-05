"""Create focused repository media from isolated, enlarged renderer captures."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import json, os, shutil, subprocess, math

ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/'.ensoul/tmp/showcase-v3'
OUT=ROOT/'docs/assets/showcase'
OUT.mkdir(parents=True,exist_ok=True)
FONT=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'
PAPER='#f6f7fa'
INK='#242936'
MUTED='#777e8b'
ACCENT='#5a70e8'
data=json.loads((RAW/'motion.json').read_text())
sources={name:Image.open(RAW/(name+'.png')).convert('RGB') for name in ['open-before','open-after','embed-before','embed-target','embed-after','tool-window','dispatch-before','dispatch-target','dispatch-received','dispatch-after']}

def font(size,bold=False,latin=False):
    return ImageFont.truetype(str(FONT/('segoeui.ttf' if latin else 'msyhbd.ttc' if bold else 'msyh.ttc')),size)
def text(im,xy,value,size,fill=INK,bold=False,latin=False):
    ImageDraw.Draw(im).text(xy,value,font=font(size,bold,latin),fill=fill)
def place(im,src,xy,width,radius=12):
    picture=src.resize((width,round(src.height*width/src.width)),Image.Resampling.LANCZOS)
    mask=Image.new('L',picture.size)
    ImageDraw.Draw(mask).rounded_rectangle((0,0,picture.width-1,picture.height-1),radius,fill=255)
    im.paste(picture,xy,mask)
def roundrect(im,box,fill,radius=14):
    ImageDraw.Draw(im).rounded_rectangle(box,radius,fill)
def cropped(name,box):
    return sources[name].crop(box)

cover=Image.new('RGB',(1400,1120),PAPER)
text(cover,(54,25),'ensoul',42,bold=True,latin=True)
text(cover,(1000,43),'A WORKSPACE YOU CAN SHAPE',16,MUTED,latin=True)
text(cover,(54,102),'想到了，就开一块。',66,bold=True)
text(cover,(57,206),'独立会话。嵌入式面板。让彼此一起工作。',26,MUTED)
place(cover,cropped('embed-after',(14,69,1266,805)),(54,280),1292)
text(cover,(57,1076),'一个会话，一块小工具。',20,MUTED)
text(cover,(1090,1076),'真实界面 · 演示数据',16,MUTED)
cover.save(OUT/'cover.png',optimize=True)

embed=Image.new('RGB',(1280,850),PAPER)
text(embed,(42,26),'拖到会话中央，松手挂入。',45,bold=True)
text(embed,(44,101),'独立的小面板，变成手边的小工具。',23,MUTED)
place(embed,cropped('embed-after',(150,145,1120,650)),(42,171),1196)
text(embed,(45,805),'场景只保留一块待办；完整挂入动作见下方动画。',18,MUTED)
embed.save(OUT/'embed.png',optimize=True)

collab=Image.new('RGB',(1280,940),PAPER)
text(collab,(42,26),'送出去，也回得来。',45,bold=True)
text(collab,(44,101),'一张便利贴，连接任务、员工和完成回执。',23,MUTED)
place(collab,cropped('dispatch-after',(14,69,1266,805)),(42,163),1196)
text(collab,(45,901),'示例回复与回执 · 未调用真实模型',17,MUTED)
collab.save(OUT/'collaborate.png',optimize=True)

share=Image.new('RGB',(1200,630),'#222b43')
text(share,(50,35),'ensoul',45,'#f6f7fa',latin=True)
text(share,(50,171),'想到了，',66,'#f6f7fa',True)
text(share,(50,262),'就开一块。',66,'#afbbff',True)
text(share,(53,390),'独立会话 / 可嵌入 / 能协作',23,'#ccd1de')
place(share,sources['tool-window'],(730,158),400)
text(share,(52,559),'YOUR PANELS. YOUR WORKSPACE.',21,'#ccd1de',latin=True)
text(share,(760,531),'从独立面板，到会话挂件。',20,'#ccd1de')
share.save(OUT/'share.png',optimize=True)

WIDTH,HEIGHT=1280,950
SCALE=1192/1280
PHOTO=(44,156)
def canvas(name,title,kicker):
    im=Image.new('RGB',(WIDTH,HEIGHT),PAPER)
    text(im,(42,19),'ensoul',27,bold=True,latin=True)
    text(im,(43,67),title,34,bold=True)
    text(im,(1030,30),kicker,17,ACCENT)
    place(im,sources[name],PHOTO,1192)
    text(im,(45,924),'真实界面 · 演示数据 · 动作与回执为脚本编排',15,MUTED)
    return im
def point(x,y):return PHOTO[0]+x*SCALE,PHOTO[1]+y*SCALE
def center(box):return point(box['x']+box['width']/2,box['y']+box['height']/2)
def ease(t):
    t=max(0,min(1,t))
    return t*t*(3-2*t)
def mix(a,b,t):return Image.blend(a,b,max(0,min(1,t)))
def cursor(im,p,pressed=False,opacity=1):
    x,y=p
    draw=ImageDraw.Draw(im)
    if pressed:draw.ellipse((x-15,y-15,x+15,y+15),outline=ACCENT,width=2)
    draw.polygon([(x,y),(x+2,y+20),(x+8,y+15),(x+13,y+25),(x+17,y+23),(x+12,y+14),(x+19,y+13)],fill='white',outline=INK,width=1)
def floating(im,picture,p,width,alpha=1):
    if alpha<=0:return
    picture=picture.resize((round(width),round(width*picture.height/picture.width)),Image.Resampling.LANCZOS).convert('RGBA')
    mask=Image.new('L',picture.size)
    ImageDraw.Draw(mask).rounded_rectangle((0,0,picture.width-1,picture.height-1),10,fill=round(255*alpha))
    x,y=round(p[0]),round(p[1])
    shadow=Image.new('RGBA',im.size)
    ImageDraw.Draw(shadow).rounded_rectangle((x+3,y+8,x+picture.width+3,y+picture.height+8),10,fill=(28,37,60,round(35*alpha)))
    im.paste(Image.alpha_composite(im.convert('RGBA'),shadow.filter(ImageFilter.GaussianBlur(9))).convert('RGB'))
    im.paste(picture,(x,y),mask)

A=canvas('open-before','需要另一件事？再开一块。','01 / 打开')
B=canvas('open-after','需要另一件事？再开一块。','01 / 打开')
C=canvas('embed-before','把小面板拖到会话中央。','02 / 挂入')
D=canvas('embed-target','把小面板拖到会话中央。','02 / 挂入')
E=canvas('embed-after','松手。边框收起，内容留下。','02 / 挂入')
F=canvas('dispatch-before','拖一张便利贴，交给他。','03 / 协作')
G=canvas('dispatch-target','拖一张便利贴，交给他。','03 / 协作')
H=canvas('dispatch-received','同一句任务，来到员工会话。','03 / 协作')
I=canvas('dispatch-after','回执回来，原卡盖章。','03 / 协作')
plus=center(data['plus'])
target=center(data['target'])
embedded=data['embedded']
finish=point(embedded['x'],embedded['y'])
note=data['from']
note_pic=cropped('dispatch-target',(round(note['x']),round(note['y']),round(note['x']+note['width']),round(note['y']+note['height'])))
note_a=center(note);note_b=center(data['to'])
frames=RAW/'motion-frames'
frames.mkdir(exist_ok=True)
FPS=30
index=0
# Five continuous shots, with eased motion instead of slide-like screenshot changes.
lengths=[2.2,3.6,1.8,3.2,3.2]
for scene,length in enumerate(lengths):
    for n in range(round(length*FPS)):
        t=n/FPS
        if scene==0:
            im=mix(A,B,ease((t-.7)/.35))
            cursor(im,plus,.55<t<.95)
        elif scene==1:
            u=ease((t-.25)/1.65)
            im=mix(C,D,ease((u-.55)/.25))
            start=(920,186)
            end=(target[0]-sources['tool-window'].width*SCALE/2,target[1]-sources['tool-window'].height*SCALE/2)
            p=(start[0]+(end[0]-start[0])*u,start[1]+(end[1]-start[1])*u-48*math.sin(math.pi*u))
            if t>2.25:
                v=ease((t-2.25)/.65)
                im=mix(D,E,v)
                p=(end[0]+(finish[0]-end[0])*v,end[1]+(finish[1]-end[1])*v)
                floating(im,sources['tool-window'],p,360*SCALE,1-v)
            else:
                floating(im,sources['tool-window'],p,360*SCALE)
                cursor(im,(p[0]+70,p[1]+18),t>1.9)
        elif scene==2:
            im=E.copy()
        elif scene==3:
            u=ease((t-.35)/1.55)
            im=mix(F,G,ease((u-.7)/.2))
            x=note_a[0]+(note_b[0]-note_a[0])*u
            y=note_a[1]+(note_b[1]-note_a[1])*u-55*math.sin(math.pi*u)
            if t<2.1:
                floating(im,note_pic,(x-note_pic.width*SCALE/2,y-note_pic.height*SCALE/2),note_pic.width*SCALE,.94)
                cursor(im,(x,y),u>.98)
            else:
                im=mix(G,H,ease((t-2.1)/.55))
        else:
            im=mix(H,I,ease((t-.35)/.7))
        im.save(frames/f'{index:04}.png',compress_level=1)
        index+=1

ffmpeg=os.environ.get('FFMPEG') or shutil.which('ffmpeg')
if not ffmpeg:raise SystemExit('Install ffmpeg or set FFMPEG to its executable path.')
input_args=[ffmpeg,'-y','-hide_banner','-loglevel','error','-framerate',str(FPS),'-i',str(frames/'%04d.png')]
subprocess.run(input_args+['-frames:v',str(index),'-c:v','libx264','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'demo.mp4')],check=True)
subprocess.run(input_args+['-filter_complex','[0:v]fps=24,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle','-t',str(index/FPS),'-loop','0',str(OUT/'demo.gif')],check=True)
print(json.dumps({'duration':index/FPS,'video_fps':FPS,'gif_fps':24,'renderer_zoom':data['zoom'],'assets':str(OUT)}))
