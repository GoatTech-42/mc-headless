# DonutSMP AFK: look straight up, sneak, hold attack (axe mines) and use. Ctrl-less loop;
# stop by disconnecting or removing the autorun line from the dashboard.
import minescript
import time
import math

yaw, start_pitch = minescript.player_orientation()
target_pitch = -90
duration = 1.0
steps = 250
for i in range(steps + 1):
    t = i / steps
    y = (1 - math.cos(math.pi * t)) / 2
    minescript.player_set_orientation(yaw, start_pitch + (target_pitch - start_pitch) * y)
    time.sleep(duration / steps)

time.sleep(0.25)
try:
    minescript.player_press_sneak(True)
    time.sleep(0.4)
    minescript.player_press_attack(True)
    time.sleep(0.5)
    minescript.player_press_use(True)
    while True:
        time.sleep(0.1)
finally:
    for f in (minescript.player_press_use, minescript.player_press_attack, minescript.player_press_sneak):
        try:
            f(False)
        except Exception:
            pass
