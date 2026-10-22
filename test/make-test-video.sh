#!/usr/bin/env bash
# Builds test/blink.mp4: 10 s, 30 fps, 540×960, with known inserts.
#   2.50 s  full red frame           (flash)
#   4.00 s  white box, ~4% of frame  (flash, partial)
#   4.50 s  thin white outline       (flash, text-like, hardest)
#   5.00 s  2 blue frames            (flash, 2-frame run)
#   6.00 s  plain scene cut          (must NOT be caught)
#   8.00 s  yellow frame during motion
#   9.00 s  green frame exactly at a scene cut (cut)
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -y -hide_banner -loglevel error -filter_complex "
testsrc2=s=540x960:r=30:d=10,format=yuv420p,split[a][b];
[b]hue=h=180,vflip[bb];
[a][bb]overlay=enable='between(n,180,269)',
drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='eq(n,75)',
drawbox=x=30:y=60:w=200:h=110:color=white:t=fill:enable='eq(n,120)',
drawbox=x=60:y=420:w=420:h=60:color=white:t=4:enable='eq(n,135)',
drawbox=x=90:y=440:w=360:h=20:color=white:t=4:enable='eq(n,135)',
drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='between(n,150,151)',
drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='eq(n,240)',
drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='eq(n,270)'
" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart blink.mp4
echo "wrote $(pwd)/blink.mp4"
