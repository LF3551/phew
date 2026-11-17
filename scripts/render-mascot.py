"""Renders docs/images/mascot-alive.png: the Phew mascot looks, thinks, reads, waits, and says phew.

The shapes and the colors follow resources/icon.svg and docs/BRAND.md.
Run: python3 scripts/render-mascot.py (needs Pillow).
"""

import math
from PIL import Image, ImageDraw

CREAM=(0xF0,0xED,0xE8,255); INK=(0x30,0x34,0x3B,255); DROP=(0x22,0xB8,0xCF,255)
S=4                  # supersampling
PAD=40               # room for the bounce and the flying drop, in drawing units
UNIT=256+2*PAD
OUT=256              # output pixels (shown at 150 in the README, sharp on retina)
FPS=12

def P(x,y,ox,oy): return ((x+PAD+ox)*S,(y+PAD+oy)*S)

def stroke(d,pts,ox=0,oy=0,w=26,color=INK):
    # A round brush along the path: smooth curves without seams between segments.
    q=[P(x,y,ox,oy) for x,y in pts]
    r=w*S/2
    dense=[q[0]]
    for (x0,y0),(x1,y1) in zip(q,q[1:]):
        n=max(1,int(math.hypot(x1-x0,y1-y0)/(S*1.5)))
        dense+=[(x0+(x1-x0)*i/n,y0+(y1-y0)*i/n) for i in range(1,n+1)]
    for x,y in dense:
        d.ellipse((x-r,y-r,x+r,y+r),fill=color)

def quad(p0,c,p2,n=32):
    return [((1-t)**2*p0[0]+2*(1-t)*t*c[0]+t*t*p2[0],(1-t)**2*p0[1]+2*(1-t)*t*c[1]+t*t*p2[1]) for t in [i/n for i in range(n+1)]]

def cubic(p0,c1,c2,p3,n=24):
    out=[]
    for i in range(n+1):
        t=i/n;u=1-t
        out.append((u**3*p0[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t**3*p3[0],u**3*p0[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t**3*p3[1]))
    return out

def drop_shape():
    pts=cubic((198,30),(184,50),(174,63),(174,77))
    pts+=[(198-24*math.cos(a),77+24*math.sin(a)) for a in [math.pi*i/24 for i in range(25)]]
    pts+=cubic((222,77),(222,63),(212,50),(198,30))
    return pts

DROP_PTS=drop_shape()

def eyes(d,face,gx=0,gy=0,blink=0.0):
    if face=="open":
        for x in (80,176):
            if blink>0:
                h=(24+26)*(1-blink*0.82)/2
                cx,cy=P(x,146,gx,gy); d.ellipse((cx-13*S,cy-h*S,cx+13*S,cy+h*S),fill=INK)
            else:
                stroke(d,[(x,134),(x,158)],gx,gy)
    elif face=="relief":
        stroke(d,quad((48,140),(80,176),(112,140)),gx,gy)
        stroke(d,quad((144,140),(176,176),(208,140)),gx,gy)

def frame(face="open",gx=0,gy=0,blink=0.0,drop=(0,0,1.0,1.0,0),body=(0,1.0,1.0)):
    """drop=(dx,dy,scale,alpha,rotation); body=(dy,sx,sy) in drawing units and factors."""
    img=Image.new("RGBA",(UNIT*S,UNIT*S),(0,0,0,0))
    face_img=Image.new("RGBA",(UNIT*S,UNIT*S),(0,0,0,0))
    d=ImageDraw.Draw(face_img)
    d.rounded_rectangle((PAD*S,PAD*S,(PAD+256)*S,(PAD+256)*S),radius=76*S,fill=CREAM)
    eyes(d,face,gx,gy,blink)
    dy,sx,sy=body
    if (dy,sx,sy)!=(0,1.0,1.0):
        w,h=face_img.size
        scaled=face_img.resize((int(w*sx),int(h*sy)),Image.LANCZOS)
        img.alpha_composite(scaled,(int((w-scaled.width)/2),int((h-scaled.height)/2+dy*S)))
    else:
        img.alpha_composite(face_img)
    ddx,ddy,ds,da,rot=drop
    if da>0:
        layer=Image.new("RGBA",img.size,(0,0,0,0))
        cx,cy=198,70
        pts=[]
        for x,y in DROP_PTS:
            x,y=(x-cx)*ds,(y-cy)*ds
            a=math.radians(rot); x,y=x*math.cos(a)-y*math.sin(a),x*math.sin(a)+y*math.cos(a)
            pts.append(P(cx+x+ddx,cy+y+ddy+dy,0,0))
        ImageDraw.Draw(layer).polygon(pts,fill=DROP[:3]+(int(255*da),))
        img.alpha_composite(layer)
    return img.resize((OUT,OUT),Image.LANCZOS)

def ease(t): return t*t*(3-2*t)

frames=[]
def add(img,n=1): frames.extend([img]*n)

def step_to(face,a,b,steps=3,**kw):
    # Tamagotchi-like moves: a few hard steps instead of a smooth slide.
    for i in range(1,steps+1):
        t=i/steps; add(frame(face,a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,**kw))

# 1. Idle: looking at you, one blink, then a double blink later.
add(frame("open"),7)
add(frame("open",blink=1.0)); add(frame("open"),6)
# 2. Thinking: eyes go up to the side.
step_to("open",(0,0),(6,-16)); add(frame("open",6,-16),7)
add(frame("open",6,-16,blink=1.0)); add(frame("open",6,-16),4)
# 3. Reading: the eyes jump along two lines.
for line_y in (6,10):
    for x in (-12,-4,4,12):
        add(frame("open",x,line_y),3)
# 4. Waiting for you: eyes up at the request, a drop of sweat runs down.
step_to("open",(12,10),(6,-16))
n=16
for i in range(n):
    t=i/(n-1)
    if t<0.15: dy,s,a=0,1,1
    else:
        u=(t-0.15)/0.85; dy,s,a=85*u,1-0.4*u,1-u if u>0.5 else 1
    add(frame("open",6,-16,drop=(0,dy,s,max(0,a),0)))
add(frame("open",6,-16,drop=(0,0,1,0,0)),2)
for i in range(1,4): add(frame("open",6,-16,drop=(0,-20*(1-i/3),0.6+0.4*i/3,i/3,0)))
# 5. Done: relief, a small bounce, and the drop is wiped away.
n=11
for i in range(n):
    t=i/(n-1)
    if t<0.3: u=t/0.3; body=(-36*u,1+0.08*u,1-0.06*u)
    elif t<0.6: u=(t-0.3)/0.3; body=(-36+46*u,1.08-0.12*u,0.94+0.10*u)
    else: u=(t-0.6)/0.4; body=(10-10*u,0.96+0.04*u,1.04-0.04*u)
    w=min(1,t/0.6)
    drop=(40*ease(w)*0.6,-60*ease(w)*0.7,1,1-w,25*w)
    add(frame("relief",body=body,drop=drop))
add(frame("relief",drop=(0,0,1,0,0)),3)
for i in range(1,4): add(frame("relief",drop=(0,-20*(1-i/3),0.6+0.4*i/3,i/3,0)))
add(frame("relief"),16)
# Back to open eyes for the loop, through a blink.
add(frame("open",blink=1.0))

# Merge equal frames into longer durations.
out,durs=[],[]
for f in frames:
    if out and f.tobytes()==out[-1].tobytes(): durs[-1]+=1000/FPS
    else: out.append(f); durs.append(1000/FPS)

out[0].save("docs/images/mascot-alive.png",save_all=True,append_images=out[1:],duration=[int(x) for x in durs],loop=0,disposal=1,blend=0,optimize=True)
print(len(frames),"frames,",len(out),"unique,",round(sum(durs)/1000,1),"s")
