# AFK mob-grinder script (Minescript). Swings only when the sword cooldown is full,
# eats from the offhand now and then. Runs inside the logged-in HeadlessMC client.
import minescript
import time
import math

HOSTILE = (
    "zombie", "skeleton", "creeper", "spider", "cave_spider", "witch", "husk",
    "stray", "drowned", "pillager", "vindicator", "slime", "magma_cube", "blaze",
    "wither_skeleton", "phantom", "silverfish", "bogged", "breeze",
)
REACH = 3.0            # blocks; vanilla survival reach is 3
COOLDOWN = 0.64        # s; sword attack speed 1.6/s means full charge at 0.625 s
EAT_EVERY = 25.0       # s between food checks
EAT_HOLD = 2.0         # s to hold use for one bite
LOOK_RANGE = 4.5


def short(t):
    return str(t).split(":")[-1].lower()


def my_pos():
    try:
        p = minescript.player_position()
        return p[0], p[1], p[2]
    except Exception:
        return None


def nearest_hostile():
    pos = my_pos()
    if pos is None:
        return None
    best, bd = None, 1e9
    try:
        ents = minescript.entities(max_distance=LOOK_RANGE)
    except Exception:
        return None
    for e in ents:
        if getattr(e, "local", False):
            continue
        if short(getattr(e, "type", "")) not in HOSTILE:
            continue
        ex, ey, ez = e.position
        d = math.sqrt((ex - pos[0]) ** 2 + (ey - pos[1]) ** 2 + (ez - pos[2]) ** 2)
        if d < bd:
            best, bd = e, d
    return best


def offhand_has_item():
    try:
        for it in minescript.player_inventory():
            if getattr(it, "slot", None) == 40:
                return True
    except Exception:
        pass
    return False


def eat():
    if not offhand_has_item():
        return
    minescript.player_press_use(True)
    time.sleep(EAT_HOLD)
    minescript.player_press_use(False)


def swing():
    minescript.player_press_attack(True)
    time.sleep(0.06)
    minescript.player_press_attack(False)


last_hit = 0.0
last_eat = time.time()
try:
    while True:
        now = time.time()
        if now - last_eat >= EAT_EVERY:
            eat()
            last_eat = time.time()
            last_hit = time.time()  # eating resets the charge window
            continue
        tgt = None
        try:
            tgt = minescript.player_get_targeted_entity(REACH)
        except Exception:
            pass
        if tgt is not None and short(getattr(tgt, "type", "")) in HOSTILE:
            if now - last_hit >= COOLDOWN:
                swing()
                last_hit = time.time()
        else:
            m = nearest_hostile()
            if m is not None:
                x, y, z = m.position
                minescript.player_look_at(x, y + 1.0, z)
        time.sleep(0.05)
finally:
    minescript.player_press_attack(False)
    minescript.player_press_use(False)
