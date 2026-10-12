#!/usr/bin/env bash
# 슬라이드용 앱 캡처 3종(4개 파일) 재촬영. 앱을 localhost:8765에서 서비스 중이어야 한다.
#   python3 -m http.server 8765   (저장소 루트에서)
# 사용: bash scripts/capture.sh   → docs/captures/*.png, *.jpg
set -euo pipefail
cd "$(dirname "$0")/.."
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
B="http://localhost:8765/"
V="nc=$(date +%s)"
cap() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$2" --virtual-time-budget=60000 --screenshot="docs/captures/$1.png" "$3" >/dev/null 2>&1
  [ -f "docs/captures/$1.png" ] && echo "OK $1" || { echo "FAIL $1"; exit 1; }; }

cap cap1_overview 1440,900 "${B}?year=2027&layer=total&zoom=15&center=37.1525,127.0485&$V"
cap cap3_bus      1280,840 "${B}?year=2027&layer=bus&view=map&labels=1&pins=0&zoom=16&center=37.1585,127.0490&$V"
cap cap2_before   1440,940 "${B}?year=2027&layer=bus&pins=0&zoom=16&center=37.1590,127.0490&$V"
cap cap2_after    1440,940 "${B}?year=2027&layer=bus&pins=0&zoom=16&center=37.1590,127.0490&add=bus:37.1622,127.0492&$V"

# 하단에 남는 빈 타일 띠 제거 후 JPG 저장
python3 - <<'EOF'
from PIL import Image
import numpy as np, os
bg = np.array([233, 235, 239])
for n, x0 in [("cap1_overview", 430), ("cap2_before", 430), ("cap2_after", 430), ("cap3_bus", 0)]:
    im = Image.open(f"docs/captures/{n}.png").convert("RGB"); a = np.asarray(im); h, w = a.shape[:2]
    cut = h
    while cut > h - 120 and (np.abs(a[cut - 1, x0:w] - bg).sum(axis=1) < 10).mean() > 0.5:
        cut -= 1
    im.crop((0, 0, w, cut)).save(f"docs/captures/{n}.jpg", quality=90, optimize=True)
    print(n, (w, cut), "잘라낸 하단", h - cut, "px")
EOF
