# MineScript telemetry loop.
# Contract v2: dashboard scrapes `TELEMETRY {json}` lines from latest.log
# (/data/.minecraft/logs/latest.log). One flat object per ~2s:
# {"v":2,"ts":epoch_s,"session":id,"seq":n,"x","y","z","yaw","pitch","health" (number|null),
#  "inventory": [{"name","count"}...<=12] | null}. Unknown values are null, never invented.
import json
import os
import time

import minescript


def call(name):
    try:
        return getattr(minescript, name)()
    except Exception:
        return None


def item_shape(it):
    # dict, object (.name/.item/.count), or tuple — try several shapes.
    try:
        return {"name": it["name"], "count": it.get("count", 1)}
    except Exception:
        pass
    for attr in ("name", "item"):
        try:
            n = getattr(it, attr)
            if n is not None:
                return {"name": str(n), "count": getattr(it, "count", 1) or 1}
        except Exception:
            pass
    if isinstance(it, (tuple, list)) and it:
        return {"name": str(it[0]), "count": it[1] if len(it) > 1 else 1}
    return {"name": str(it)[:60], "count": 1}


SESSION = "%d-%d" % (int(time.time()), os.getpid())


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf") else None


def at(seq, i):
    try:
        return num(seq[i])
    except Exception:
        return None


seq = 0
while True:
    try:
        pos = call("player_position")
        orient = call("player_orientation")
        inv = call("player_inventory")
        items = None
        if isinstance(inv, (list, tuple)):
            items = []
            for it in inv[:12]:
                try:
                    items.append(item_shape(it))
                except Exception:
                    items.append({"name": str(it)[:60], "count": 1})
        seq += 1
        payload = {
            "v": 2,
            "ts": time.time(),
            "session": SESSION,
            "seq": seq,
            "x": at(pos, 0),
            "y": at(pos, 1),
            "z": at(pos, 2),
            "yaw": at(orient, 0),
            "pitch": at(orient, 1),
            "health": num(call("player_health")),
            "inventory": items,
        }
        minescript.echo("TELEMETRY " + json.dumps(payload, default=str))
    except Exception:
        pass
    time.sleep(2)
